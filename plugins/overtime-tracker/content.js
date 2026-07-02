// 加班工时实时统计 - content script
// 规则(可配置,在 popup 中调整):
//   - baseHours: 每日标准工时(默认 9)
//   - thresholdHours: 加班门槛(默认 2),延后超过才计入
//   - targetHours: 月度目标(默认 48)
//   - ruleMode: "user"(用你的规则) | "raw"(信任页面 Stzbzsc)
//
// 算法(每日):
//   标准下班 = 上班 + baseHours
//   延后 = 实际下班 - 标准下班
//   加班 = (延后 > threshold) ? 延后 : 0
//   无下班打卡 / 法定节假日 → 加班 = 0
//   时间精度:分钟

(function () {
  "use strict";

  // 版本号 (跟 manifest.json 同步, 改的时候两边一起改)
  const VERSION = "2.3.3";

  // ===== URL 白名单:只在指定考勤页面运行 =====
  // 加了 <all_urls> 后 content.js 会注入到所有页面
  // 必须自己过滤,否则在百度/掘金/任何网站都会蹦出红色 OT 标签
  // v2.2.3: 加 path 前缀, 避免同域名其他页面也蹦出面板
  //   允许: oa.aciic.cn/hr/... 和 soa.com.cn/oaataticsv/attendance/...
  //   拒绝: oa.aciic.cn/home/... 等同域名其他路径
  const HOST_OK =
    (location.hostname === "oa.aciic.cn" && location.pathname.startsWith("/hr/")) ||
    (location.hostname === "soa.com.cn" && location.pathname.startsWith("/oaataticsv/attendance")) ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname.startsWith("172.");

  if (!HOST_OK) return;  // 不在考勤页,直接退出,啥都不做

  if (window.__overtimeTrackerInjected) return;
  window.__overtimeTrackerInjected = true;

  // ===== 诊断标记:只要插件注入成功,右上角就有这个红色 OT 小标签 =====
  // 不依赖业务数据,用来确认 "插件到底跑没跑"
  function injectBadge() {
    if (document.getElementById("__ot_badge__")) return;
    const b = document.createElement("div");
    b.id = "__ot_badge__";
    b.textContent = "OT";
    b.title = `v${VERSION} - 加班工时插件已注入`;
    b.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;" +
      "background:#dc2626;color:#fff;font:bold 11px/1 sans-serif;" +
      "padding:4px 6px;border-radius:4px;cursor:help;" +
      "box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:auto;";
    b.addEventListener("click", () => {
      alert(`✅ 加班工时插件 v${VERSION} 已注入\nURL: ` + location.href +
        "\n时间: " + new Date().toLocaleString() +
        "\n\n如果看不到主面板,说明业务逻辑没跑起来\n把 URL 发给开发者");
    });
    (document.body || document.documentElement).appendChild(b);
  }
  if (document.body) injectBadge();
  else document.addEventListener("DOMContentLoaded", injectBadge);

  // ============ 默认规则 ============
  const DEFAULT_RULES = {
    // 排班模式: "elastic" = 弹性(按总工时算) | "fixed" = 固定(标准下班时间)
    scheduleMode: "elastic",
    workStartTime: "09:00",  // 显示用, 固定模式也会用来算每日工时
    workEndTime:   "18:00",  // 固定模式的核心: 实际下班跟这个比
    baseHours: 9,            // 弹性模式的目标工时; 固定模式从 workStart/End 自动算
    thresholdHours: 2,
    targetHours: 48,
    ruleMode: "user",  // "user" = 按你的规则算 | "raw" = 信任页面字段

    // 周末/节假日规则(只算时间, 不分弹性)
    weekendThreshold: 4,  // 超过 4h 才算加班
    weekendMax: 8,        // 一天最多算 8h

    // 交通补贴(仅固定模式工作日)
    subsidyStartTime: "21:00",  // 超过这个时间的部分算补贴时段

    // 多月统计
    aggregateMonths: 12,  // 默认近一年
  };

  // 计算某天的"标准下班时间"(分钟)
  function getStandardEnd(sMin, rules) {
    if (rules.scheduleMode === "fixed" && rules.workEndTime) {
      const endMin = toMin(rules.workEndTime);
      if (endMin != null) return endMin;
    }
    // 弹性: 实际上班 + 目标工时
    return sMin + rules.baseHours * 60;
  }

  let RULES = { ...DEFAULT_RULES };

  // 多月统计的渲染缓存, 防止 render() 把抓取中/抓取结果给冲掉
  let aggregateCache = "";

  // 从 chrome.storage 加载规则
  function loadRules() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(DEFAULT_RULES, (stored) => {
        RULES = { ...DEFAULT_RULES, ...stored };
        render();
      });
    }
  }

  // 监听规则变化(popup 改了立即生效)
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const newRules = { ...RULES };
      for (const [k, v] of Object.entries(changes)) {
        newRules[k] = v.newValue;
      }
      RULES = { ...DEFAULT_RULES, ...newRules };
      render();
    });
  }

  // ============ 工具函数 ============
  function toMin(hhmm) {
    if (!hhmm) return null;
    const m = String(hhmm).match(/^(\d{1,2}):(\d{1,2})$/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function minToTime(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
  function minToStr(m) {
    if (m == null) return "-";
    const sign = m < 0 ? "-" : "";
    m = Math.abs(Math.round(m));
    return `${sign}${Math.floor(m / 60)}h ${m % 60}m`;
  }
  function hoursToStr(h) {
    if (!h || h <= 0) return "0h";
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    if (mm === 0) return `${hh}h`;
    if (hh === 0) return `${mm}m`;
    return `${hh}h ${mm}m`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ============ 数据采集 ============
  // 从日历 .events-list 读每日打卡
  // 格式: <span>07:48 - 21:01 </span>
  // 特殊: 旷工(8.00) / 节假日 / 无打卡
  // ============ 数据源:优先 DOM,备用 json_data ============
  // 重要:实测 window.json_data = undefined(它在 IIFE 闭包内)
  // 但日历 .events-list span 里数据齐全(共 29 个事件)
  // 所以主路径走 DOM 解析
  function readDailyPunches() {
    // 1. 尝试 json_data(如果将来变量暴露到 window)
    const jsonData = window.json_data;
    if (Array.isArray(jsonData) && jsonData.length > 0) {
      return parseJsonData(jsonData);
    }

    // 2. 主路径:从日历 DOM 解析
    return parseCalendarDOM();
  }

  function parseJsonData(arr) {
    return arr.map(ev => {
      const date = ev.id || "";
      const wt = (ev.worktime || "").replace(/<br>/g, " ").replace(/<[^>]+>/g, "");
      // v2.2.5: split 后两侧各自匹配, 支持"只打上班没打下班"
      const parts = wt.split(/\s*-\s*/);
      const startMatch = parts[0] && parts[0].match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
      const endMatch   = parts[1] && parts[1].match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
      let start = null, end = null;
      if (startMatch) start = `${startMatch[1].padStart(2, "0")}:${startMatch[2]}`;
      if (endMatch)   end   = `${endMatch[1].padStart(2, "0")}:${endMatch[2]}`;
      let note = null;
      if (start && end && start === end) { note = "旷工"; end = null; }
      else if (ev.holidayname && ev.holidayname.indexOf("法定") >= 0) note = "法定节假日";
      else if (wt.includes("旷工")) note = "旷工";
      else if (wt.includes("未打卡")) note = "未打卡";
      else if (wt.includes("调休")) note = "调休";
      else if (wt.includes("年假")) note = "年假";
      else if (wt.includes("病假")) note = "病假";
      else if (wt.includes("事假")) note = "事假";
      else if (wt.includes("婚假")) note = "婚假";
      else if (wt.includes("丧假")) note = "丧假";
      else if (wt.includes("产假")) note = "产假";
      return { date, start, end, note };
    });
  }

    function parseCalendarDOM() {
    // 关键修正:data-cal-date 在 .cal-month-day 内的 <span> 上,不是 div 自己
    // 所以选择器必须是 ".cal-month-day [data-cal-date]",不能是 ".cal-month-day[data-cal-date]"
    const dateEls = document.querySelectorAll(
      "#calendar .cal-month-day [data-cal-date]"
    );

    // ===== 不要用 Year/Month input 过滤 =====
    // 教训:实测 Year=2026 Month=5,但日历实际显示 6 月
    // 用 input 过滤会把 30 格全过滤掉,只留 1 格假数据
    // data-cal-date 才是真相,直接信任
    const yearEl = document.getElementById("Year");
    const monthEl = document.getElementById("Month");
    const inputYM = (yearEl && monthEl)
      ? `${yearEl.value}-${String(monthEl.value).padStart(2, "0")}`
      : null;

    const days = [];
    let parsed = 0;
    let skipped = 0;
    let debugSamples = [];

    dateEls.forEach(dateEl => {
      const dateStr = dateEl.getAttribute("data-cal-date");
      if (!dateStr) { skipped++; return; }
      // 不再按 currentYM 过滤
      // 之前是: if (currentYM && !dateStr.startsWith(currentYM)) { skipped++; return; }

      // 父 cell
      const cell = dateEl.closest(".cal-month-day") || dateEl.parentElement;
      const cellClasses = cell ? cell.className : "";
      const isInMonth = cellClasses.includes("cal-day-inmonth");

      // ===== 关键:跳过 outmonth(灰色数字,是上下月填充) =====
      // 用户原话:"显示黑色的数字的格子才是这个月"
      if (!isInMonth) { skipped++; return; }

      const isHoliday = cellClasses.includes("cal-day-holiday");
      const isWeekend = cellClasses.includes("cal-day-weekend");

      // ===== 关键:找打卡文本 =====
      // 在 .events-list 内找
      let text = "";
      const eventsList = cell ? cell.querySelector(".events-list") : null;

      if (eventsList) {
        // 优先取 events-list 第一个 span(那是打卡时间)
        const firstSpan = eventsList.querySelector("span");
        if (firstSpan) text = firstSpan.textContent.trim();
        // 备选:events-list 自己的 textContent(去掉空白)
        if (!text || !text.match(/\d.*-/)) {
          text = eventsList.textContent.replace(/\s+/g, " ").trim();
        }
      }

      // 最终备选:cell 全部文本
      if (!text || !text.match(/\d.*-/)) {
        text = (cell ? cell.textContent : "").replace(/\s+/g, " ").trim();
      }

      // 解析 "HH:MM - HH:MM" 或 "HH:MM:SS - HH:MM:SS" (soa.com.cn 格式)
// 也支持只有一边的情况 (如 "08:02:14 - " 只打了上班卡)
// (?::\d{2})? 允许可选的秒数, 避免贪婪匹配到 MM:SS
// v2.2.5 修复: 老正则要求两边都匹配, "只打上班没打下班" 时整条不匹配 → start=null
//   → buildReminder 误判"没上班", 提醒不显示
//   改成 split 后两侧各自匹配, 一边有就解析一边
      const parts = text.split(/\s*-\s*/);
      const startMatch = parts[0] && parts[0].match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
      const endMatch   = parts[1] && parts[1].match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
      let start = null, end = null;
      if (startMatch) start = `${startMatch[1].padStart(2, "0")}:${startMatch[2]}`;
      if (endMatch)   end   = `${endMatch[1].padStart(2, "0")}:${endMatch[2]}`;

      // 判定
      let note = null;
      if (start && end && start === end) {
        note = "旷工";
        end = null;
      } else if (text.includes("未打卡")) {
        note = "未打卡";
      } else if (text.includes("旷工")) {
        note = "旷工";
        end = null;
      } else if (text.includes("端午节") || text.includes("中秋") || text.includes("春节") ||
                 text.includes("国庆") || text.includes("元旦") || text.includes("清明") ||
                 text.includes("劳动节") || text.includes("儿童节") || text.includes("妇女节")) {
        note = "法定节假日";
      } else if (text.includes("加班")) note = "加班";
      else if (text.includes("调休")) note = "调休";
      else if (text.includes("年假")) note = "年假";
      else if (text.includes("病假")) note = "病假";
      else if (text.includes("事假")) note = "事假";
      else if (text.includes("婚假")) note = "婚假";
      else if (text.includes("丧假")) note = "丧假";
      else if (text.includes("产假")) note = "产假";
      else if (text.includes("陪产假")) note = "陪产假";
      else if (text.includes("工伤")) note = "工伤假";
      else if (isHoliday && !start && !end) {
        // 关键修复:仅当 isHoliday 且无打卡时,才算法定节假日
        // 6/1 儿童节虽被系统标 cal-day-holiday,但有实际打卡 → 按工作日算 OT
        note = "法定节假日";
      }
      else if (isWeekend && !start && !end) note = "周末无打卡";

      days.push({
        date: dateStr,
        start, end, note,
        isWeekend,
        isHoliday,
        rawText: text.slice(0, 30),
      });
      if (start || end) parsed++;
      if (debugSamples.length < 3) debugSamples.push({ date: dateStr, text: text.slice(0, 40), start, end, note, isWeekend, isHoliday });
    });

    window.__otDebug = {
      source: "calendar-dom",
      totalDateEls: dateEls.length,
      inputYearMonth: inputYM,  // 留着,后续排查 input 与数据对不上时用
      skipped,
      parsed,
      sample: debugSamples,
    };
    return days;
  }

  // ============ 计算引擎 ============
  // ============ 计算引擎 ============
  // ============ 计算引擎 ============
  // ============ 计算引擎 ============
  // 按用户规则计算
  // 日类型分三种:
  //   1) 工作日(weekday): 走 scheduleMode (弹性/固定)
  //   2) 周末(weekend): 不分弹性, workDuration > 周末阈值 才算, 封顶 weekendMax
  //   3) 节假日(holiday): 同周末规则
  // 交通补贴规则:
  //   工作日: eMin >= subsidyStartTime (默认 21:00) → 1 次
  //   周末/节假日: workMin > 4h → 1 次, workMin > 9h → 2 次
  function computeUserRule(days, rules) {
    const thresholdMin = rules.thresholdHours * 60;
    const baseMin = rules.baseHours * 60;
    const weekendThresholdMin = (rules.weekendThreshold || 4) * 60;
    const weekendMaxMin = (rules.weekendMax || 8) * 60;
    const isFixed = rules.scheduleMode === "fixed";
    const workEndMin = isFixed ? toMin(rules.workEndTime) : null;
    const subsidyStartMin = toMin(rules.subsidyStartTime || "21:00");

    // 这些 note = 一定没加班 (请假类/未打卡)
    const skipNotes = new Set([
      "调休", "年假", "病假", "事假", "婚假", "丧假",
      "产假", "陪产假", "工伤假", "未打卡",
    ]);

    const details = [];
    let totalMin = 0;
    let totalSubsidyCount = 0;
    let overtimeDays = 0;

    for (const d of days) {
      const sMin = toMin(d.start);
      const eMin = toMin(d.end);

      // 无下班打卡 → 0
      if (!eMin) {
        details.push({ ...d, overtimeMin: 0, delayMin: 0, subsidyCount: 0, reason: "无下班打卡" });
        continue;
      }

      // 请假类 note → 0
      if (d.note && skipNotes.has(d.note)) {
        details.push({ ...d, overtimeMin: 0, delayMin: 0, subsidyCount: 0, reason: d.note });
        continue;
      }

      const workMin = eMin - sMin;
      const isWeekend = !!d.isWeekend;
      const isHoliday = d.note === "法定节假日";
      const isWeekendOrHoliday = isWeekend || isHoliday;

      let overtimeMin = 0, delayMin = 0, reason = "";

      if (isWeekendOrHoliday) {
        // 周末/节假日: 超过 weekendThreshold 算, 封顶 weekendMax
        if (workMin > weekendThresholdMin) {
          overtimeMin = Math.min(workMin, weekendMaxMin);
          delayMin = overtimeMin;
          reason = overtimeMin >= weekendMaxMin
            ? `周末/节假日加班(封顶 ${rules.weekendMax || 8}h)`
            : "周末/节假日加班";
        } else {
          overtimeMin = 0;
          delayMin = 0;
          reason = `周末/节假日工作 ${minToStr(workMin)} (未达 ${rules.weekendThreshold || 4}h)`;
        }
      } else {
        // 工作日: 走 scheduleMode
        const standardEnd = isFixed && workEndMin != null
          ? workEndMin
          : sMin + baseMin;
        delayMin = eMin - standardEnd;
        overtimeMin = delayMin > thresholdMin ? delayMin : 0;

        if (overtimeMin > 0) reason = "加班";
        else if (delayMin > 0) reason = `延后 ${minToStr(delayMin)} 未达门槛`;
        else reason = "正常下班";
      }

      // 交通补贴次数:
      //   工作日: eMin >= subsidyStartTime → 1 次
      //   周末/节假日: workMin > 9h → 2 次, workMin > 4h → 1 次
      let subsidyCount = 0;
      if (isWeekendOrHoliday) {
        if (workMin > 9 * 60) subsidyCount = 2;
        else if (workMin > weekendThresholdMin) subsidyCount = 1;
      } else {
        if (subsidyStartMin != null && eMin >= subsidyStartMin) subsidyCount = 1;
      }

      totalMin += overtimeMin;
      totalSubsidyCount += subsidyCount;
      if (overtimeMin > 0) overtimeDays++;

      details.push({ ...d, overtimeMin, delayMin, subsidyCount, reason });
    }

    return {
      totalMin,
      totalHours: totalMin / 60,
      totalSubsidyCount,
      overtimeDays,
      totalDays: days.filter(d => d.start || d.end).length,
      details,
    };
  }

  // 信任页面 Stzbzsc
  function readRawZbzsc() {
    const el = document.getElementById("Stzbzsc");
    if (!el) return 0;
    const v = (el.value || "").trim();
    if (!v) return 0;
    // 兼容 "12.5" / "12:30" / "12h30m"
    let m = v.match(/^(\d{1,3}):(\d{1,2})$/);
    if (m) return parseInt(m[1]) + parseInt(m[2]) / 60;
    m = v.match(/(\d+(?:\.\d+)?)\s*(?:小时|h|H)/i);
    if (m) {
      const h = parseFloat(m[1]);
      const mm = v.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|m|min)/i);
      return h + (mm ? parseFloat(mm[1]) / 60 : 0);
    }
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // ============ 多月统计 ============
  // 通过点 Prev 按钮 + DOM 监听, 翻历史月份拿数据
  function getCurrentPageYearMonth() {
    const yEl = document.getElementById("Year");
    const mEl = document.getElementById("Month");
    if (!yEl || !mEl) return null;
    return {
      year: parseInt(yEl.value, 10),
      month: parseInt(mEl.value, 10),
    };
  }

  function findNavButton(direction) {
    // direction: "prev" 或 "next"
    // 多种匹配模式, 提高命中率
    const candidates = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"]'
    );
    const exactPatterns = direction === "prev"
      ? ["<", "Prev", "<< Prev", "<<", "上月", "< 上月", "Previous", "上个月", "Previous Month",
         "<Prev", "< Prev", "< previous", "<Previous"]
      : [">", "Next", "Next >>", ">>", "下月", "Next>", "下个月", "Next Month",
         "Next>", "Next >", ">Next", "Next >"];
    for (const el of candidates) {
      const text = (el.textContent || el.value || "").trim();
      if (exactPatterns.includes(text)) return el;
    }
    // 部分匹配兜底: 也加上 < 和 > 字符匹配 (oa.aciic.cn 上 "< Prev" 这种)
    const partialRegex = direction === "prev"
      ? /^(<|Prev|prev|Previous|previous|上月|上个月)/
      : /^(>|Next|next|下月|下个月)/;
    for (const el of candidates) {
      const text = (el.textContent || el.value || "").trim();
      if (partialRegex.test(text)) return el;
    }
    return null;
  }

  function findPrevMonthButton() {
    return findNavButton("prev");
  }

  function findNextMonthButton() {
    return findNavButton("next");
  }

  // 翻到指定年月 (基于当前页, 算差值决定点击 Next 还是 Prev)
  async function navigateToMonth(targetYM) {
    let currentYM = getCurrentPageYearMonth();
    if (!currentYM || !targetYM) return false;
    const currentIdx = currentYM.year * 12 + currentYM.month;
    const targetIdx = targetYM.year * 12 + targetYM.month;
    let diff = currentIdx - targetIdx;
    if (diff === 0) return true;

    // 安全检查: 差值过大就中止, 防止点击命中错按钮导致跑飞
    if (Math.abs(diff) > 24) {
      console.warn(`[OT] 翻月差值过大 (${diff} 月), 中止. 当前: ${currentYM.year}-${currentYM.month}, 目标: ${targetYM.year}-${targetYM.month}`);
      return false;
    }

    const direction = diff > 0 ? "next" : "prev";
    const clicks = Math.abs(diff);
    console.log(`[OT] 翻月回去: ${clicks} 次 ${direction} (${currentYM.year}-${currentYM.month} → ${targetYM.year}-${targetYM.month})`);

    for (let i = 0; i < clicks; i++) {
      const btn = direction === "next" ? findNextMonthButton() : findPrevMonthButton();
      if (!btn) {
        console.warn(`[OT] 找不到 ${direction} 按钮, 中断翻月 (${i + 1}/${clicks})`);
        return false;
      }
      const beforeYM = getCurrentPageYearMonth();
      btn.click();
      await waitForCalendarUpdate();
      const afterYM = getCurrentPageYearMonth();
      // 检查点击是否生效: 年月没变就重试一次
      if (!afterYM || (afterYM.year === beforeYM.year && afterYM.month === beforeYM.month)) {
        console.warn(`[OT] ${direction} 点击后年月没变, 重试一次 (${i + 1}/${clicks})`);
        // 重试前先尝试找别的按钮
        const retryBtn = direction === "next" ? findNextMonthButton() : findPrevMonthButton();
        if (retryBtn) {
          retryBtn.click();
          await waitForCalendarUpdate();
        } else {
          return false;
        }
      }
      // 再次检查, 如果还不对就 abort
      const finalYM = getCurrentPageYearMonth();
      if (!finalYM || (finalYM.year === beforeYM.year && finalYM.month === beforeYM.month)) {
        console.warn(`[OT] ${direction} 点击重试仍无效, 中止 (${i + 1}/${clicks})`);
        return false;
      }
    }
    return true;
  }

  // 等待日历 DOM 更新 (MutationObserver) 或兜底 2s 超时
  function waitForCalendarUpdate() {
    return new Promise((resolve) => {
      const target = document.getElementById("calendar");
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        observer && observer.disconnect();
        resolve();
      };
      let observer = null;
      if (target) {
        observer = new MutationObserver(() => {
          // 等一会儿确认渲染完成
          setTimeout(finish, 200);
        });
        observer.observe(target, { childList: true, subtree: true });
      }
      setTimeout(finish, 2000);  // 兜底
    });
  }

  // 抓取近 N 个月的数据 (含本月)
  // 返回 [{ year, month, days, ot }, ...]
  async function fetchHistoricalMonths(count, onProgress) {
    const result = [];
    // 当前页 = 第 1 个月
    let ym = getCurrentPageYearMonth();
    if (!ym) {
      console.warn("[OT] 找不到 Year/Month input, 无法抓历史");
      return result;
    }

    for (let i = 0; i < count; i++) {
      // 读当前页面数据
      const days = readDailyPunches();
      const r = computeUserRule(days, RULES);
      result.push({
        year: ym.year,
        month: ym.month,
        days,
        totalMin: r.totalMin,
        totalHours: r.totalHours,
        overtimeDays: r.overtimeDays,
        totalSubsidyCount: r.totalSubsidyCount,
      });
      onProgress && onProgress(i + 1, count, ym);

      // 还有下个月要翻
      if (i < count - 1) {
        const prevBtn = findPrevMonthButton();
        if (!prevBtn) {
          console.warn("[OT] 找不到 Prev 按钮, 中断抓取");
          break;
        }
        prevBtn.click();
        await waitForCalendarUpdate();
        ym = getCurrentPageYearMonth();
        if (!ym) break;
      }
    }
    return result;
  }

  function computeAggregate(monthlyData) {
    const monthCount = monthlyData.length;
    let totalMin = 0, totalSubsidyCount = 0, totalOvertimeDays = 0;
    const perMonth = [];
    for (const m of monthlyData) {
      totalMin += m.totalMin;
      totalSubsidyCount += m.totalSubsidyCount;
      totalOvertimeDays += m.overtimeDays;
      perMonth.push({
        year: m.year, month: m.month,
        totalMin: m.totalMin, totalHours: m.totalHours,
        overtimeDays: m.overtimeDays,
        totalSubsidyCount: m.totalSubsidyCount,
      });
    }
    return {
      monthCount,
      totalMin, totalHours: totalMin / 60,
      avgMin: monthCount > 0 ? totalMin / monthCount : 0,
      avgHours: monthCount > 0 ? (totalMin / monthCount) / 60 : 0,
      totalSubsidyCount,
      totalOvertimeDays,
      perMonth,
    };
  }

  // 多月统计点击处理 (从 panel 事件委托里调用)
  async function handleAggregateClick(btn) {
    const panel = btn.closest("#overtime-tracker-panel");
    if (!panel) return;
    const resultEl = panel.querySelector("[data-result]");
    if (!resultEl) return;

    // 用 select 当前值, 不读 RULES (select 改了还没持久化时, RULES 还没更新)
    const sel = panel.querySelector("[data-aggregate-months]");
    const months = sel ? parseInt(sel.value, 10) : (RULES.aggregateMonths || 12);
    if (!months || months < 1) {
      resultEl.innerHTML = "❌ 月数无效";
      return;
    }

    // 记下起始年月, 抓完要跳回去
    const startYM = getCurrentPageYearMonth();

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = "⏳ 抓取中...";

    const setProgress = (html) => {
      resultEl.innerHTML = html;
      // 同步缓存, render() 触发时不会被冲掉
      aggregateCache = html;
    };
    setProgress(`⏳ 抓取中... (0/${months})`);

    try {
      const monthly = await fetchHistoricalMonths(months, (cur, total, ym) => {
        setProgress(`⏳ 抓取中... (${cur}/${total}) · ${ym.year}-${String(ym.month).padStart(2, "0")}`);
      });
      if (monthly.length === 0) {
        setProgress(`❌ 没找到 Prev 按钮或 Year/Month input, 无法翻月 (面板会回到当月)`);
        btn.disabled = false;
        btn.textContent = oldText;
        return;
      }
      const agg = computeAggregate(monthly);
      const thisMonth = monthly[0];
      const diffMin = thisMonth.totalMin - agg.avgMin;
      const diffCls = diffMin >= 0 ? "ot-good" : "ot-warn";
      const diffSign = diffMin >= 0 ? "+" : "";
      const trend = diffMin >= 0 ? "📈" : "📉";

      // 月度明细 (倒序, 最新在最上面)
      let monthlyHtml = `<div class="ot-monthly-list">`;
      for (let i = monthly.length - 1; i >= 0; i--) {
        const m = monthly[i];
        monthlyHtml += `<div class="ot-monthly-row"><span>${m.year}-${String(m.month).padStart(2, "0")}</span><span>${hoursToStr(m.totalHours)}</span><span>${m.overtimeDays}天</span><span>🚕×${m.totalSubsidyCount}</span></div>`;
      }
      monthlyHtml += `</div>`;

      setProgress(`
        <div class="ot-aggregate-stats">
          <div class="ot-row"><span class="ot-label">📊 近 ${agg.monthCount} 月累计</span><span class="ot-value">${hoursToStr(agg.totalHours)}</span></div>
          <div class="ot-row"><span class="ot-label">📊 月均加班</span><span class="ot-value">${hoursToStr(agg.avgHours)}</span></div>
          <div class="ot-row ${diffCls}"><span class="ot-label">${trend} 本月 vs 月均</span><span class="ot-value">${diffSign}${hoursToStr(Math.abs(diffMin) / 60)}</span></div>
          ${monthlyHtml}
        </div>
      `);

      // 翻月回到起始月 (注意: 此时页面已在历史月份上, 需要用 Next 反向回来)
      if (startYM) {
        setProgress(aggregateCache + `<div style="margin-top:4px;color:#9ca3af">⏳ 翻回当月 ${startYM.year}-${String(startYM.month).padStart(2, "0")}...</div>`);
        const ok = await navigateToMonth(startYM);
        if (ok) {
          setProgress(aggregateCache.replace(/<div style="margin-top:4px;color:#9ca3af">.*?<\/div>/s, ""));
          render();  // 用当月数据重新渲染主面板
        } else {
          setProgress(aggregateCache.replace(/<div style="margin-top:4px;color:#9ca3af">.*?<\/div>/s, "")
            + `<div style="margin-top:4px;color:#dc2626">⚠️ 翻回当月失败, 请手动点 "Today" 回到当月</div>`);
        }
      }
      btn.disabled = false;
      btn.textContent = "🔄 重新加载";
    } catch (e) {
      console.error("[OT] aggregate error:", e);
      setProgress(`❌ 出错: ${e.message || e}`);
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  // ============ 打卡提醒 ============
  // 检测今天:有上班打卡 + 没下班打卡 → 该提醒了
  function buildReminder(days, rules) {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const todayData = days.find(d => d.date === todayStr);
    if (!todayData) return "";        // 今天不在数据里(页面还没加载?)
    if (!todayData.start) return "";  // 还没打上班卡
    if (todayData.end) return "";     // 已经打了下班卡,不用提醒

    const startMin = toMin(todayData.start);
    if (startMin == null) return "";
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const elapsedMin = nowMin - startMin;
    if (elapsedMin <= 0) return "";   // 异常,上班时间在未来
    if (elapsedMin < 60) return "";   // 刚上班 1h 内,不打扰

    const baseMin = rules.baseHours * 60;
    // 提醒的"标准下班时间"也按模式走
    // 固定模式: 直接用 workEndTime; 弹性: 上班 + baseHours
    let standardEndMin;
    if (rules.scheduleMode === "fixed" && rules.workEndTime) {
      standardEndMin = toMin(rules.workEndTime) ?? (startMin + baseMin);
    } else {
      standardEndMin = startMin + baseMin;
    }
    const delay = nowMin - standardEndMin;
    const startStr = todayData.start;
    const elapsedStr = hoursToStr(elapsedMin / 60);

    if (delay > 60) {
      // 已过下班时间 1h+, 紧急:红色脉动
      return `<div class="ot-reminder ot-reminder-urgent">🔔 你 ${startStr} 上班, 已工作 ${elapsedStr}, 过下班时间 ${hoursToStr(delay / 60)}, 快去打卡下班!</div>`;
    } else if (delay > 0) {
      // 已到下班时间, 警告:黄色
      return `<div class="ot-reminder ot-reminder-warning">⏰ 你 ${startStr} 上班, 已到下班时间(${minToTime(standardEndMin)}), 记得打卡!</div>`;
    } else if (delay > -60) {
      // 距离下班 1h 内, 提示:蓝色
      return `<div class="ot-reminder ot-reminder-info">⏰ 你 ${startStr} 上班, 还有 ${Math.abs(delay)} 分钟下班</div>`;
    } else {
      // 距离下班 > 1h, 灰色: 提醒已上班 + 还有多久下班
      const remainMin = standardEndMin - nowMin;
      return `<div class="ot-reminder ot-reminder-normal">📍 你 ${startStr} 上班, 已工作 ${elapsedStr}, 还有 ${minToStr(remainMin)} 到下班时间</div>`;
    }
  }

  // ============ 渲染 ============
  let panel = null;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "overtime-tracker-panel";
    panel.innerHTML = `
      <div class="ot-header">
        <span class="ot-title">📊 加班工时</span>
        <div class="ot-actions">
          <button class="ot-btn" data-action="refresh" title="刷新">⟳</button>
          <button class="ot-btn" data-action="expand" title="展开明细">▾</button>
          <button class="ot-btn" data-action="toggle" title="折叠">−</button>
        </div>
      </div>
      <div class="ot-body" data-body></div>
      <div class="ot-detail" data-detail style="display:none"></div>
      <div class="ot-footer" data-footer>实时同步</div>
    `;
    document.body.appendChild(panel);

    // ===== 事件委托: 监听整个 panel, 根据 data-action 分发 =====
    // 原因: aggregate 按钮在 body.innerHTML 里, render() 会重建它
    //       直接挂监听会丢, 委托到 panel 上就没这个问题
    panel.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target || !panel.contains(target)) return;
      const action = target.dataset.action;
      if (action === "refresh") {
        render();
      } else if (action === "toggle") {
        panel.classList.toggle("collapsed");
        const detailVisible = panel.querySelector("[data-detail]").style.display !== "none";
        target.textContent =
          panel.classList.contains("collapsed") ? "+" : (detailVisible ? "−" : "−");
      } else if (action === "expand") {
        const d = panel.querySelector("[data-detail]");
        const showing = d.style.display !== "none";
        d.style.display = showing ? "none" : "block";
        target.textContent = showing ? "▾" : "▴";
      } else if (action === "aggregate") {
        handleAggregateClick(target);
      }
    });

    // select 改月数时实时保存
    panel.addEventListener("change", (e) => {
      if (e.target.matches("[data-aggregate-months]")) {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && n >= 1 && n <= 12) {
          RULES = { ...RULES, aggregateMonths: n };
          try {
            chrome.storage.sync.set({ aggregateMonths: n });
          } catch (_) {}
          // 顺手更新按钮文案
          const btn = panel.querySelector("[data-action=\"aggregate\"]");
          if (btn) btn.textContent = `📊 加载近 ${n} 月统计`;
        }
      }
    });
    // aggregate 按钮的点击处理委托到 panel 上 (见 ensurePanel 里的 panel.addEventListener)

    makeDraggable(panel);
    return panel;
  }

  function render() {
    const p = ensurePanel();
    const body = p.querySelector("[data-body]");
    const detail = p.querySelector("[data-detail]");
    const footer = p.querySelector("[data-footer]");

    const days = readDailyPunches();
    const debug = window.__otDebug || {};
    if (days.length === 0) {
      const jsonType = window.json_data === null ? "null" :
                       Array.isArray(window.json_data) ? "Array[" + window.json_data.length + "]" :
                       typeof window.json_data;
      const cellsRendered = document.querySelectorAll("#calendar .events-list span").length;
      body.innerHTML = `
        <div class="ot-empty">⏳ 等待数据…</div>
        <div class="ot-empty" style="font-size:10px;margin-top:6px;line-height:1.5;text-align:left">
          window.json_data = <b>${jsonType}</b><br>
          日历 DOM 事件数: <b>${cellsRendered}</b><br>
          (数据异步加载中,会自动刷新)
        </div>
      `;
      detail.innerHTML = "";
      footer.textContent = "等待数据…";
      return;
    }
    // 检查是否真的解析到了打卡
    const withPunch = days.filter(d => d.start && d.end);
    if (withPunch.length === 0 && days.length > 0) {
      // v2.2.4 修复: 即使没有完整打卡也要先尝试显示下班提醒
      // 场景: 今天只打了上班卡, 没打下班卡 → 应当提醒"该打卡下班了"
      const reminderHtml = buildReminder(days, RULES);
      body.innerHTML = `
        ${reminderHtml}
        <div class="ot-empty">⚠️ 找到 ${days.length} 个日历格,但没有完整打卡</div>
        <div class="ot-empty" style="font-size:11px">可能是月初、节假日月份或空数据</div>
      `;
      detail.innerHTML = "";
      footer.textContent = "数据为空";
      return;
    }

    let totalHours, overtimeDays, totalDays, details, totalSubsidyCount = 0;

    if (RULES.ruleMode === "raw") {
      totalHours = readRawZbzsc();
      overtimeDays = "-";
      totalDays = days.length;
      details = days;
    } else {
      const r = computeUserRule(days, RULES);
      totalHours = r.totalHours;
      overtimeDays = r.overtimeDays;
      totalDays = r.totalDays;
      details = r.details;
      totalSubsidyCount = r.totalSubsidyCount;
    }

    // 目标对比
    const target = RULES.targetHours;
    const pct = target > 0 ? (totalHours / target) * 100 : 0;
    const remain = Math.max(0, target - totalHours);

    // 颜色
    let zbClass = "ot-value";
    let zbIcon = "⏱";
    let pctClass = "";
    if (pct >= 100) { zbClass += " highlight"; zbIcon = "🔥"; pctClass = "over"; }
    else if (pct >= 60) { zbClass += " good"; zbIcon = "✅"; }
    else if (pct >= 30) { zbClass += " ok"; zbIcon = "⏳"; }
    else { zbIcon = "🌱"; }

    body.innerHTML = `
      ${buildReminder(days, RULES)}
      <div class="ot-row">
        <span class="ot-label">${zbIcon} 本月累计加班</span>
        <span class="${zbClass}">${hoursToStr(totalHours)}</span>
      </div>
      <div class="ot-progress">
        <div class="ot-progress-bar ${pctClass}" style="width:${Math.min(100, pct).toFixed(1)}%"></div>
      </div>
      <div class="ot-row ot-row-meta">
        <span class="ot-label">目标 ${target}h 完成度</span>
        <span class="ot-value">${pct.toFixed(1)}%</span>
      </div>
      <div class="ot-row">
        <span class="ot-label">${pct >= 100 ? "🎉 已超额" : "📉 还差"}</span>
        <span class="ot-value">${pct >= 100 ? `+${hoursToStr(totalHours - target)}` : hoursToStr(remain)}</span>
      </div>
      <div class="ot-row">
        <span class="ot-label">加班天数</span>
        <span class="ot-value">${overtimeDays} / ${totalDays} 天</span>
      </div>
      ${totalSubsidyCount > 0 ? `
      <div class="ot-row">
        <span class="ot-label">🚕 交通补贴次数</span>
        <span class="ot-value" style="color:#d97706">${totalSubsidyCount} 次</span>
      </div>
      ` : ""}
      <div class="ot-row ot-rule-hint">
        <span class="ot-label">规则: ${
          RULES.scheduleMode === "fixed"
            ? `固定 ${RULES.workStartTime}-${RULES.workEndTime}`
            : `弹性 ${RULES.baseHours}h`
        } · 阈值 ${RULES.thresholdHours}h · 目标 ${RULES.targetHours}h${totalSubsidyCount > 0 ? ` · 补贴≥${RULES.subsidyStartTime}` : ""}</span>
      </div>
      <div class="ot-aggregate">
        <div class="ot-aggregate-controls">
          <select data-aggregate-months>
            <option value="1"${RULES.aggregateMonths === 1 ? " selected" : ""}>本月</option>
            <option value="3"${RULES.aggregateMonths === 3 ? " selected" : ""}>近 3 月</option>
            <option value="6"${RULES.aggregateMonths === 6 ? " selected" : ""}>近 6 月</option>
            <option value="12"${RULES.aggregateMonths === 12 ? " selected" : ""}>近 12 月</option>
          </select>
          <button class="ot-btn-secondary" data-action="aggregate">📊 加载</button>
        </div>
        <div class="ot-aggregate-result" data-result></div>
      </div>
    `;

    // 每日明细
    let detailHtml = `<div class="ot-detail-title">📅 每日明细</div>`;
    if (RULES.ruleMode !== "raw") {
      details.forEach(d => {
        const s = d.start || "--:--";
        const e = d.end || "--:--";
        const ot = d.overtimeMin ? hoursToStr(d.overtimeMin / 60) : "-";
        const cls = d.overtimeMin > 0 ? "ot-detail-row ot" :
                    (d.reason && d.reason.includes("延后") ? "ot-detail-row near" :
                    (d.note ? "ot-detail-row skip" : "ot-detail-row normal"));
        const reason = d.reason || d.note || "";
        const subsidy = d.subsidyCount > 0 ? ` · 🚕×${d.subsidyCount}` : "";
        detailHtml += `
          <div class="${cls}">
            <span class="ot-d-date">${d.date.slice(5)}</span>
            <span class="ot-d-time">${s}–${e}</span>
            <span class="ot-d-ot">${ot}</span>
            <span class="ot-d-reason">${reason}${subsidy}</span>
          </div>
        `;
      });
    } else {
      detailHtml += `<div class="ot-empty">原始模式:未计算每日明细</div>`;
    }
    detail.innerHTML = detailHtml;

    // v2.3.2 修复: 抓取中或抓取结果被 render() 覆盖的问题
    // 缓存 aggregate 状态, render 之后恢复
    if (typeof aggregateCache !== "undefined" && aggregateCache) {
      const resultEl = panel.querySelector("[data-result]");
      if (resultEl) resultEl.innerHTML = aggregateCache;
    }

    const now = new Date();
    footer.textContent = `v${VERSION} · 更新于 ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} · ${RULES.ruleMode === "raw" ? "原始" : "自定义规则"}`;
  }

  // ============ 拖拽 ============
  function makeDraggable(el) {
    const header = el.querySelector(".ot-header");
    let startX, startY, startLeft, startTop, dragging = false;
    header.addEventListener("pointerdown", e => {
      if (e.target.closest(".ot-btn")) return;
      dragging = true;
      el.classList.add("dragging");
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", e => {
      if (!dragging) return;
      el.style.left = (startLeft + e.clientX - startX) + "px";
      el.style.top  = (startTop + e.clientY - startY) + "px";
      el.style.right = "auto";
    });
    header.addEventListener("pointerup", e => {
      dragging = false;
      el.classList.remove("dragging");
      try { header.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }

  // ============ 监听日历变化 ============
  function watchCalendar() {
    const target = document.getElementById("calendar");
    if (!target) {
      // 还没渲染好,500ms 后重试
      return setTimeout(watchCalendar, 500);
    }
    const observer = new MutationObserver(() => {
      clearTimeout(window.__otDebounce);
      window.__otDebounce = setTimeout(render, 300);
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  // ============ 启动 ============
  function init() {
    try { ensurePanel(); } catch(e) { console.error("[OT] ensurePanel:", e); }
    try { injectBadge(); } catch(e) { console.error("[OT] injectBadge:", e); }
    try { loadRules(); } catch(e) { console.error("[OT] loadRules:", e); }
    try { render(); } catch(e) { console.error("[OT] render:", e); }
    try { watchCalendar(); } catch(e) { console.error("[OT] watchCalendar:", e); }

    // ===== 智能轮询 =====
    // 关键修复:document_idle 触发时 DOM 可能还没渲染完
    // 必须持续轮询,直到拿到非零数据
    let lastHash = null;
    let stableCount = 0;
    const poll = setInterval(() => {
      try {
        // 计算"数据指纹"
        // 修正选择器:data-cal-date 在 span 上,不是 .cal-month-day 自己
        const cells = document.querySelectorAll("#calendar .cal-month-day [data-cal-date]");
        const cellsWithPunch = document.querySelectorAll("#calendar .cal-month-day .events-list span");
        const hash = cells.length + ":" + cellsWithPunch.length + ":" +
                     (cellsWithPunch[0]?.textContent || "").slice(0, 10);

        if (hash !== lastHash) {
          // 变了:刷新
          lastHash = hash;
          stableCount = 0;
          render();
        } else {
          stableCount++;
          // 稳定 5 次(2.5 秒)就停止轮询,避免无谓消耗
          if (stableCount >= 5 && cellsWithPunch.length > 0) {
            clearInterval(poll);
          }
        }

        // 30 次后(15 秒)兜底停止
        if (stableCount > 30) clearInterval(poll);
      } catch (e) {
        console.error("[OT] poll:", e);
      }
    }, 500);

    // 30 秒兜底刷新
    setInterval(() => { try { render(); } catch(e) { console.error("[OT] render-tick:", e); } }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
