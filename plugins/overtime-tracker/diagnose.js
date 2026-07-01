// 诊断脚本:把这个文件拖到 Chrome 的扩展管理页面运行,会输出所有诊断信息
// 用法:打开 chrome://extensions/ → 找到本扩展 → 点"service worker"或"检查视图:service worker"
//       (Manifest V3 在 background/service worker 标签里),然后在控制台粘贴执行:
//       import('/home/dlyrm/overtime-tracker/diagnose.js')
// 或者更简单:在 hygon 考勤页面 F12 Console 直接粘贴下面整段(去掉开头的 // 注释)

(async function diagnose() {
  console.log("===== 加班插件诊断报告 =====\n");

  // 1. 插件是否注入
  console.log("1. 插件注入状态:", window.__overtimeTrackerInjected ? "✅ 已注入" : "❌ 未注入");

  // 2. 面板是否存在
  const panel = document.getElementById("overtime-tracker-panel");
  console.log("2. 悬浮窗元素:", panel ? "✅ 存在" : "❌ 不存在");
  if (panel) {
    const rect = panel.getBoundingClientRect();
    console.log("   - 位置:", `top=${rect.top}, right=${window.innerWidth - rect.right}, width=${rect.width}, height=${rect.height}`);
    console.log("   - 可见:", rect.width > 0 && rect.height > 0 ? "✅ 可见" : "❌ 不可见(尺寸为 0)");
    console.log("   - 父元素 z-index 链:", window.getComputedStyle(panel).zIndex);
    console.log("   - 当前显示内容前 200 字符:");
    console.log("     ", panel.textContent.trim().slice(0, 200).replace(/\s+/g, " "));
  }

  // 3. 当前 URL 是否在 matches 范围
  console.log("\n3. 当前 URL:", location.href);
  console.log("   - 域名:", location.hostname);
  console.log("   - 路径:", location.pathname);

  // 4. 日历数据是否就绪
  const calCells = document.querySelectorAll("#calendar .cal-cell1.cal-cell .cal-month-day.cal-day-inmonth");
  console.log("\n4. 日历中当月单元格数量:", calCells.length, calCells.length > 0 ? "✅" : "❌");
  if (calCells.length > 0) {
    const withEvents = Array.from(calCells).filter(c => c.querySelector(".events-list span")?.textContent.trim());
    console.log("   - 含打卡事件的:", withEvents.length);
    if (withEvents.length > 0) {
      const first = withEvents[0];
      console.log("   - 第一个事件示例(HTML 片段):");
      console.log("     ", first.querySelector(".events-list span").outerHTML);
    }
  }

  // 5. 用更宽松的选择器再试
  const looseA = document.querySelectorAll(".cal-month-day");
  const looseB = document.querySelectorAll(".events-list");
  const looseC = document.querySelectorAll("[data-cal-date]");
  console.log("\n5. 备用选择器探测:");
  console.log("   - .cal-month-day:", looseA.length);
  console.log("   - .events-list:", looseB.length);
  console.log("   - [data-cal-date]:", looseC.length);
  if (looseC.length > 0) {
    const c = looseC[0];
    const cls = c.closest(".cal-month-day")?.className || "无";
    console.log("   - 第一个 [data-cal-date] 的 cal-month-day class:", cls);
    console.log("   - 它的 innerHTML 片段:", c.parentElement?.parentElement?.outerHTML?.slice(0, 400));
  }

  // 6. 读一下关键 input 字段(看页面数据是否就绪)
  console.log("\n6. 关键 input 字段:");
  ["Stzbzsc", "StPsnCN", "CurrUser_1", "StMonthWordDay"].forEach(id => {
    const el = document.getElementById(id);
    console.log(`   - #${id}: ${el ? `"${el.value}"` : "❌ 元素不存在"}`);
  });

  // 7. 错误检测
  console.log("\n7. 页面 title:", document.title);
  console.log("   jQuery:", typeof window.jQuery, "版本:", window.jQuery?.fn?.jquery);
  console.log("   整页 #calendar 容器:", !!document.getElementById("calendar"));

  console.log("\n===== 诊断结束 =====");
  console.log("把以上输出截图发给我即可定位问题。");
})();
