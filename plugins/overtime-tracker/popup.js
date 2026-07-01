// 加班规则配置 popup
const FIELDS = [
  "scheduleMode", "workStartTime", "workEndTime", "baseHours",
  "thresholdHours", "subsidyStartTime",
  "weekendThreshold", "weekendMax",
  "targetHours", "ruleMode",
];
const DEFAULTS = {
  scheduleMode: "elastic",
  workStartTime: "09:00",
  workEndTime:   "18:00",
  baseHours: 9,
  thresholdHours: 2,
  subsidyStartTime: "21:00",
  weekendThreshold: 4,
  weekendMax: 8,
  targetHours: 48,
  ruleMode: "user",
};

function parseTime(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function updateUI() {
  const mode = document.getElementById("scheduleMode").value;
  document.getElementById("fixedFields").style.display    = mode === "fixed"    ? "" : "none";
  document.getElementById("elasticFields").style.display  = mode === "elastic"  ? "" : "none";
  document.getElementById("modeHint").textContent =
    mode === "fixed"
      ? "加班 = 实际下班 − 标准下班 − 门槛"
      : "加班 = 实际工时 − 目标工时 − 门槛";

  if (mode === "fixed") {
    const s = parseTime(document.getElementById("workStartTime").value);
    const e = parseTime(document.getElementById("workEndTime").value);
    if (s != null && e != null && e > s) {
      const hours = (e - s) / 60;
      document.getElementById("dailyHoursDisplay").textContent =
        Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
    } else {
      document.getElementById("dailyHoursDisplay").textContent = "(时间无效)";
    }
  }
}

// 加载
chrome.storage.sync.get(DEFAULTS, (stored) => {
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (el) el.value = stored[k];
  }
  updateUI();
});

// 联动刷新
["scheduleMode", "workStartTime", "workEndTime"].forEach(id => {
  document.getElementById(id).addEventListener("input", updateUI);
  document.getElementById(id).addEventListener("change", updateUI);
});

// 保存
document.getElementById("save").addEventListener("click", () => {
  const status = document.getElementById("status");
  const values = {};
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (k === "ruleMode" || k === "scheduleMode" || k === "workStartTime" || k === "workEndTime" || k === "subsidyStartTime") {
      values[k] = el.value;
    } else {
      values[k] = parseFloat(el.value);
    }
  }

  // 数字字段校验
  for (const k of ["baseHours", "thresholdHours", "weekendThreshold", "weekendMax", "targetHours"]) {
    if (isNaN(values[k]) || values[k] < 0) {
      status.className = "error";
      status.textContent = `❌ ${k} 必须是 ≥0 的数字`;
      return;
    }
  }

  chrome.storage.sync.set(values, () => {
    status.className = "success";
    status.textContent = "✅ 已保存, 页面会自动刷新";
    setTimeout(() => status.className = "", 2000);
  });
});

// 恢复默认
document.getElementById("reset").addEventListener("click", () => {
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (el) el.value = DEFAULTS[k];
  }
  updateUI();
  const status = document.getElementById("status");
  status.className = "success";
  status.textContent = "↺ 已重置为默认, 记得点保存";
  setTimeout(() => status.className = "", 2500);
});
