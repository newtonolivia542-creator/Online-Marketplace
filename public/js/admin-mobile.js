// Phone layout helper for the admin tables. The tables are drawn by admin.js
// after the data loads, so this watches each table and copies each column
// heading onto its cells (data-label). On a phone the CSS in admin.css turns
// every row into a small card and shows that label beside each value.
(function () {
  function labelCells(table) {
    var heads = Array.prototype.map.call(
      table.querySelectorAll("thead th"),
      function (th) { return th.textContent.trim(); }
    );

    Array.prototype.forEach.call(table.querySelectorAll("tbody tr"), function (row) {
      Array.prototype.forEach.call(row.children, function (cell, index) {
        if (cell.tagName === "TD" && heads[index] && cell.getAttribute("data-label") !== heads[index]) {
          cell.setAttribute("data-label", heads[index]);
        }
      });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("table"), function (table) {
    labelCells(table);

    new MutationObserver(function () { labelCells(table); })
      .observe(table, { childList: true, subtree: true });
  });
})();
