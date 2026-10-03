/* Credit-card and transfer upgrade. Keeps the existing my-expenses-v2 data key. */
(function () {
  const ACCOUNT_TYPES = { bank: "Bank Account", credit: "Credit Card", cash: "Cash" };
  const uuid = () => crypto.randomUUID();
  const isCredit = account => account?.type === "credit";
  const posted = t => t.date <= today();
  const transactionPosition = transaction => data.transactions.indexOf(transaction);
  function newestTransactionFirst(a, b) {
    return b.date.localeCompare(a.date) || transactionPosition(b) - transactionPosition(a);
  }
  window.transactionNewestFirst = newestTransactionFirst;

  function migrate(input) {
    const migrated = input && Array.isArray(input.accounts) && Array.isArray(input.transactions)
      ? input : { accounts: [], categories: [], transactions: [] };
    migrated.accounts.forEach(a => {
      if (!ACCOUNT_TYPES[a.type]) a.type = "bank";
      a.opening = Math.abs(Number(a.opening || 0));
    });
    migrated.transactions.forEach(t => {
      t.amount = Math.abs(Number(t.amount || 0));
      if (!t.recurring) t.recurring = "oneoff";
    });
    migrated.schemaVersion = 3;
    return migrated;
  }

  data = migrate(data);
  save();

  function accountDelta(t, accountId) {
    const account = getAcc(accountId);
    if (t.type === "transfer") {
      if (t.account === accountId) return isCredit(account) ? Number(t.amount) : -Number(t.amount);
      if (t.toAccount === accountId) return isCredit(account) ? -Number(t.amount) : Number(t.amount);
      return 0;
    }
    if (t.account !== accountId) return 0;
    if (t.type === "expense") return isCredit(account) ? Number(t.amount) : -Number(t.amount);
    return isCredit(account) ? -Number(t.amount) : Number(t.amount);
  }

  function accountBalance(account, cutoff = today()) {
    return Number(account.opening || 0) + data.transactions
      .filter(t => t.date <= cutoff && (t.account === account.id || t.toAccount === account.id))
      .reduce((sum, t) => sum + accountDelta(t, account.id), 0);
  }

  function balanceAfterTransaction(transaction, account) {
    const transactionIndex = data.transactions.indexOf(transaction);
    return Number(account.opening || 0) + data.transactions.reduce((sum, item, index) => {
      const belongsToAccount = item.account === account.id || item.toAccount === account.id;
      const happenedByThen = item.date < transaction.date || (item.date === transaction.date && index <= transactionIndex);
      return belongsToAccount && happenedByThen ? sum + accountDelta(item, account.id) : sum;
    }, 0);
  }

  function balanceAfterHtml(transaction, from, to) {
    const fromLabel = isCredit(from) ? "owed after" : "balance after";
    if (!to) return `<div class="tx-balance">${esc(from.name)} ${fromLabel}: <b>${money(balanceAfterTransaction(transaction, from))}</b></div>`;
    const toLabel = isCredit(to) ? "owed after" : "balance after";
    return `<div class="tx-balance">${esc(from.name)} ${fromLabel}: <b>${money(balanceAfterTransaction(transaction, from))}</b><br>${esc(to.name)} ${toLabel}: <b>${money(balanceAfterTransaction(transaction, to))}</b></div>`;
  }

  signed = function (t) {
    if (t.type === "transfer") return 0;
    const a = getAcc(t.account);
    return accountDelta(t, a.id);
  };

  currentBalance = function () {
    return data.accounts.reduce((sum, a) => sum + (isCredit(a) ? -accountBalance(a) : accountBalance(a)), 0);
  };

  const oldProcessRecurring = processRecurring;
  processRecurring = function () {
    const count = oldProcessRecurring();
    // Older generated transfers may not have retained the destination in malformed backups.
    data.transactions.filter(t => t.type === "transfer" && !t.toAccount).forEach(t => t.invalidTransfer = true);
    return count;
  };

  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .account-type,.tx-kind{display:inline-block;padding:3px 7px;border-radius:999px;background:rgba(10,132,255,.1);color:var(--accent);font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.04em}
      .account-type.credit,.tx-kind.purchase{background:rgba(255,59,48,.1);color:var(--red)}
      .tx-kind.transfer,.tx-kind.repayment{background:rgba(175,82,222,.12);color:#af52de}
      .account-amount{text-align:right}.account-amount .muted{margin-top:2px}
      .tx-balance{margin-top:4px;color:var(--muted);font-size:11.5px;line-height:1.4}.tx-balance b{color:var(--text);font-weight:700}
      .field-hidden{display:none}.summary-note{margin-top:7px}.transfer-arrow{color:var(--muted);padding:0 3px}
    `;
    document.head.appendChild(style);
  }

  function installUi() {
    const grid = document.querySelector("#dashboard .grid");
    grid.innerHTML = `
      <div class="card stat hero-balance"><div class="label">Net worth</div><div id="balance" class="value">£0</div><div class="muted summary-note">Assets minus credit-card debt</div></div>
      <div class="card stat"><div class="label">Cash & bank</div><div id="assetTotal" class="value green">£0</div></div>
      <div class="card stat"><div class="label">Credit cards owed</div><div id="debtTotal" class="value red">£0</div></div>
      <div class="card stat"><div class="label">Net this month</div><div id="monthNet" class="value">£0</div><div class="muted summary-note"><span id="monthIncome">£0</span> in · <span id="monthSpend">£0</span> spent</div></div>`;

    document.querySelector("#transactions .tabs").innerHTML = `
      <button class="on" onclick="setTxFilter('all',this)">All</button>
      <button onclick="setTxFilter('expense',this)">Purchases</button>
      <button onclick="setTxFilter('income',this)">Income</button>
      <button onclick="setTxFilter('transfer',this)">Transfers</button>
      <button onclick="setTxFilter('recurring',this)">Recurring</button>`;

    el("reportCats").insertAdjacentHTML("afterend", `<div class="section-title"><h2>Spending by merchant</h2></div><div id="reportMerchants"></div>`);

    document.querySelector("#txModal .sheet").innerHTML = `
      <h2 id="txTitle">Add transaction</h2><form class="form" onsubmit="saveTx(event)">
      <label>Type<select id="txType" onchange="syncTxForm()"><option value="expense">Purchase / expense</option><option value="income">Income / refund</option><option value="transfer">Transfer / card repayment</option></select></label>
      <label>Amount<input id="txAmount" type="number" step="0.01" min="0.01" required placeholder="0.00"></label>
      <label>Description<input id="txDesc" required placeholder="e.g. Tesco groceries or Amex payment"></label>
      <label id="txMerchantField">Merchant<input id="txMerchant" placeholder="e.g. Tesco, Amazon or Shell"></label>
      <label id="txCatField">Category<select id="txCat"></select></label>
      <label><span id="txAccountLabel">Account</span><select id="txAccount" onchange="syncTxForm()"></select></label>
      <label id="txToField" class="field-hidden">To account<select id="txToAccount"></select></label>
      <label>Date<input id="txDate" type="date" required></label>
      <label>Transaction option<select id="txRecurring"><option value="oneoff">One-off</option><option value="weekly">Recurring — weekly</option><option value="monthly">Recurring — monthly</option><option value="yearly">Recurring — yearly</option></select></label>
      <label>Notes<input id="txNotes" placeholder="Optional"></label>
      <div class="actions"><button type="button" class="btn secondary" onclick="closeModal('txModal')">Cancel</button><button class="btn">Save</button></div></form>`;

    document.querySelector("#accountModal .sheet").innerHTML = `
      <h2>Add account</h2><form class="form" onsubmit="saveAccount(event)">
      <label>Name<input id="accName" required placeholder="e.g. Barclays Current or Amex"></label>
      <label>Account type<select id="accType" onchange="syncAccountForm()"><option value="bank">Bank Account</option><option value="credit">Credit Card</option><option value="cash">Cash</option></select></label>
      <label><span id="accBalanceLabel">Opening balance</span><input id="accBalance" type="number" step="0.01" min="0" value="0"></label>
      <div id="accHelp" class="muted">Enter the cash available in this account.</div>
      <div class="actions"><button type="button" class="btn secondary" onclick="closeModal('accountModal')">Cancel</button><button class="btn">Save</button></div></form>`;
  }

  window.syncAccountForm = function () {
    const credit = el("accType").value === "credit";
    el("accBalanceLabel").textContent = credit ? "Opening amount owed" : "Opening balance";
    el("accHelp").textContent = credit ? "Enter the amount already owed as a positive number." : "Enter the cash available in this account.";
  };

  fillSelects = function () {
    el("txCat").innerHTML = data.categories.map(c => `<option value="${c.id}">${c.icon} ${esc(c.name)}</option>`).join("");
    const options = data.accounts.map(a => `<option value="${a.id}">${esc(a.name)} — ${ACCOUNT_TYPES[a.type]}</option>`).join("");
    el("txAccount").innerHTML = options;
    el("txToAccount").innerHTML = options;
  };

  window.syncTxForm = function () {
    const transfer = el("txType").value === "transfer";
    const expense = el("txType").value === "expense";
    el("txMerchantField").classList.toggle("field-hidden", !expense);
    el("txCatField").classList.toggle("field-hidden", transfer);
    el("txToField").classList.toggle("field-hidden", !transfer);
    el("txAccountLabel").textContent = transfer ? "From account" : "Account";
    if (transfer && el("txToAccount").value === el("txAccount").value) {
      const other = data.accounts.find(a => a.id !== el("txAccount").value);
      if (other) el("txToAccount").value = other.id;
    }
  };

  openTx = function () {
    if (!data.accounts.length) { alert("Add an account first."); showView("settings"); return; }
    editingId = null; el("txTitle").textContent = "Add transaction"; fillSelects();
    el("txType").value = "expense"; el("txAmount").value = ""; el("txDesc").value = ""; el("txMerchant").value = "";
    el("txDate").value = today(); el("txRecurring").value = "oneoff"; el("txNotes").value = "";
    syncTxForm(); el("txModal").classList.add("open");
  };

  saveTx = function (event) {
    event.preventDefault();
    const type = el("txType").value;
    if (type === "transfer" && data.accounts.length < 2) return alert("Add a second account before making a transfer.");
    if (type === "transfer" && el("txAccount").value === el("txToAccount").value) return alert("Choose two different accounts.");
    const existing = editingId ? data.transactions.find(x => x.id === editingId) : null;
    const t = { id: editingId || uuid(), type, amount: Math.abs(Number(el("txAmount").value)), description: el("txDesc").value.trim(), merchant: type === "expense" ? el("txMerchant").value.trim() : "", category: type === "transfer" ? null : el("txCat").value, account: el("txAccount").value, date: el("txDate").value, recurring: el("txRecurring").value, notes: el("txNotes").value.trim() };
    if (type === "transfer") t.toAccount = el("txToAccount").value;
    if (existing?.generatedFrom) { t.generatedFrom = existing.generatedFrom; t.autoPosted = existing.autoPosted; }
    if (editingId) data.transactions[data.transactions.findIndex(x => x.id === editingId)] = t; else data.transactions.push(t);
    save(); closeModal("txModal"); render();
  };

  editTx = function (id) {
    const t = data.transactions.find(x => x.id === id); editingId = id; fillSelects();
    el("txTitle").textContent = t.type === "transfer" ? "Edit transfer" : "Edit transaction";
    el("txType").value = t.type; el("txAmount").value = t.amount; el("txDesc").value = t.description; el("txMerchant").value = t.merchant || "";
    if (t.category) el("txCat").value = t.category; el("txAccount").value = t.account;
    if (t.toAccount) el("txToAccount").value = t.toAccount; el("txDate").value = t.date;
    el("txRecurring").value = t.recurring || "oneoff"; el("txNotes").value = t.notes || "";
    syncTxForm(); el("txModal").classList.add("open");
  };

  openAccount = function () {
    el("accountModal").classList.add("open"); el("accName").value = ""; el("accType").value = "bank"; el("accBalance").value = "0"; syncAccountForm();
  };

  saveAccount = function (event) {
    event.preventDefault(); data.accounts.push({ id: uuid(), name: el("accName").value.trim(), type: el("accType").value, opening: Math.abs(Number(el("accBalance").value || 0)) });
    save(); closeModal("accountModal"); render();
  };

  deleteAccount = function (id) {
    if (data.accounts.length === 1) return alert("Keep at least one account.");
    if (data.transactions.some(t => t.account === id || t.toAccount === id)) return alert("This account has transactions or transfers. Delete those first.");
    data.accounts = data.accounts.filter(a => a.id !== id); save(); render();
  };

  renderAccounts = function () {
    el("accountList").innerHTML = data.accounts.map(a => {
      const b = accountBalance(a), debt = isCredit(a);
      return `<div class="row"><div><b>${esc(a.name)}</b><div><span class="account-type ${a.type}">${ACCOUNT_TYPES[a.type]}</span></div></div><div class="account-amount"><b class="${debt ? "red" : ""}">${money(Math.max(0, b))}</b><div class="muted">${debt ? "owed" : "available"}</div></div></div>`;
    }).join("");
  };

  txHtml = function (t, actions = false) {
    const transfer = t.type === "transfer", from = getAcc(t.account), to = transfer ? getAcc(t.toAccount) : null;
    const purchase = t.type === "expense" && isCredit(from), repayment = transfer && isCredit(to);
    const kind = repayment ? "repayment" : (purchase ? "purchase" : t.type);
    const label = repayment ? "Card repayment" : (purchase ? "Card purchase" : (transfer ? "Transfer" : (t.type === "income" ? "Income / refund" : "Expense")));
    const c = transfer ? { icon: repayment ? "💳" : "↔️", name: label } : getCat(t.category);
    const future = t.date > today(), tag = future ? " · ◷ scheduled" : (t.autoPosted ? " · ⚡ auto-posted" : (t.recurring !== "oneoff" ? " · ↻ " + t.recurring : ""));
    const merchant = t.type === "expense" && t.merchant ? `${esc(t.merchant)} · ` : "";
    const route = transfer ? `${esc(from.name)} <span class="transfer-arrow">→</span> ${esc(to.name)}` : `${merchant}${esc(c.name)} · ${esc(from.name)}`;
    const amountClass = transfer ? "" : (t.type === "income" ? "green" : "red"), sign = transfer ? "" : (t.type === "income" ? "+" : "−");
    const after = balanceAfterHtml(t, from, to);
    return `<div class="row"><div class="left"><div class="icon">${c.icon}</div><div><b>${esc(t.description)}</b><div><span class="tx-kind ${kind}">${label}</span></div><div class="muted">${route} · ${fmtDate(t.date)}${tag}</div>${after}</div></div><div style="text-align:right"><div class="amount ${amountClass}">${sign}${money(t.amount)}</div>${actions ? `<button class="btn small secondary" onclick="editTx('${t.id}')">Edit</button> <button class="btn small danger" onclick="deleteTx('${t.id}')">Delete</button>` : ""}</div></div>`;
  };

  renderRecent = function () {
    const items = data.transactions
      .filter(transaction => transaction.date <= today())
      .sort(newestTransactionFirst)
      .slice(0, 5);
    el("recentList").innerHTML = items.length
      ? items.map(transaction => txHtml(transaction)).join("")
      : `<div class="empty">No transactions yet. Tap ＋ Add to get started.</div>`;
  };

  renderTx = function () {
    let items = [...data.transactions].sort(newestTransactionFirst);
    if (["expense", "income", "transfer"].includes(txFilter)) items = items.filter(t => t.type === txFilter);
    if (txFilter === "recurring") items = items.filter(t => t.recurring !== "oneoff");
    el("txList").innerHTML = items.length ? items.map(t => txHtml(t, true)).join("") : `<div class="empty">No transactions</div>`;
  };

  renderSettings = function () {
    el("settingsAccounts").innerHTML = data.accounts.map(a => `<div class="row"><span><b>${esc(a.name)}</b><br><span class="account-type ${a.type}">${ACCOUNT_TYPES[a.type]}</span></span><button class="btn small danger" onclick="deleteAccount('${a.id}')">Delete</button></div>`).join("");
    el("categoryChips").innerHTML = data.categories.map(c => `<span class="chip">${c.icon} ${esc(c.name)} <button onclick="deleteCategory('${c.id}')" style="background:none">×</button></span>`).join("");
  };

  const originalRenderReports = renderReports;
  function renderMerchantReport() {
    const now = new Date();
    const start = reportMode === "weekly" ? new Date(now) : new Date(now.getFullYear(), now.getMonth(), 1);
    if (reportMode === "weekly") start.setDate(now.getDate() - 6);
    const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const totals = {};
    data.transactions.filter(t => {
      const date = new Date(t.date + "T00:00:00");
      return t.type === "expense" && date >= startDate && date <= now;
    }).forEach(t => {
      const merchant = (t.merchant || "").trim() || "Unspecified merchant";
      totals[merchant] = (totals[merchant] || 0) + Number(t.amount);
    });
    const merchants = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    el("reportMerchants").innerHTML = merchants.length ? merchants.map(([merchant, total]) =>
      `<div class="row"><span>🏪 ${esc(merchant)}</span><b>${money(total)}</b></div>`
    ).join("") : `<div class="empty">No merchant spending in this period</div>`;
  }

  renderReports = function () {
    // Exclude transfers from every report figure, including the transaction count.
    const allTransactions = data.transactions;
    data.transactions = allTransactions.filter(t => t.type !== "transfer");
    originalRenderReports();
    data.transactions = allTransactions;
    renderMerchantReport();
  };

  render = function () {
    processRecurring();
    el("dateLabel").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    const mt = monthTx(), reportable = mt.filter(t => t.type !== "transfer");
    const spend = reportable.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
    const income = reportable.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
    const assets = data.accounts.filter(a => !isCredit(a)).reduce((s, a) => s + accountBalance(a), 0);
    const debt = data.accounts.filter(isCredit).reduce((s, a) => s + Math.max(0, accountBalance(a)), 0);
    el("balance").textContent = money(assets - debt); el("assetTotal").textContent = money(assets); el("debtTotal").textContent = money(debt);
    el("monthSpend").textContent = money(spend); el("monthIncome").textContent = money(income); el("monthNet").textContent = money(income - spend);
    el("monthNet").className = "value " + (income - spend >= 0 ? "green" : "red");
    el("catMonth").textContent = new Date().toLocaleDateString("en-GB", { month: "long" });
    renderMtdComparison(); renderCats(mt); renderAccounts(); renderRecent(); renderTx(); renderReports(); renderSettings();
  };

  importData = function (event) {
    const file = event.target.files[0]; if (!file) return; const reader = new FileReader();
    reader.onload = () => { try { const restored = JSON.parse(reader.result); if (!Array.isArray(restored.accounts) || !Array.isArray(restored.categories) || !Array.isArray(restored.transactions)) throw Error(); if (!confirm("Replace current app data with this backup?")) return; data = migrate(restored); save(); processRecurring(); render(); alert("Backup restored and upgraded. Recurring transactions due up to today were auto-posted."); } catch { alert("Invalid backup file."); } };
    reader.readAsText(file); event.target.value = "";
  };

  installStyles(); installUi(); render();
})();


/* Transaction import and account editing upgrade. Keeps the existing my-expenses-v2 data key. */
(function () {
  let editingAccountId = null;
  let pendingImports = [];

  function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function transactionFingerprint(transaction) {
    return [
      transaction.date,
      normalizeText(transaction.description).toLowerCase(),
      Math.abs(Number(transaction.amount || 0)).toFixed(2),
      transaction.account
    ].join("|");
  }

  function installImportUi() {
    const backupHeading = [...document.querySelectorAll("#settings h3")].find(node => node.textContent.trim() === "Backup & restore");
    if (!backupHeading) return;
    backupHeading.insertAdjacentHTML("beforebegin", [
      "<hr>",
      "<h3>Transaction import</h3>",
      '<div class="muted">Add transactions from a JSON file without replacing your accounts, categories, or existing records.</div>',
      '<div class="actions"><button class="btn secondary" onclick="document.getElementById(\'transactionImportFile\').click()">Import transactions</button></div>',
      '<input id="transactionImportFile" type="file" accept=".json,application/json" style="display:none" onchange="prepareTransactionImport(event)">'
    ].join(""));

    document.body.insertAdjacentHTML("beforeend", [
      '<div id="transactionImportModal" class="modal" onclick="if(event.target===this)closeTransactionImport()">',
      '<div class="sheet"><h2>Import transactions</h2>',
      '<div class="form">',
      '<label>Account<select id="importAccount"></select></label>',
      '<label>Default category<select id="importCategory"></select></label>',
      '<div id="importSummary" class="notice"></div>',
      '<div id="importPreview" class="list"></div>',
      '<div class="actions"><button type="button" class="btn secondary" onclick="closeTransactionImport()">Cancel</button>',
      '<button type="button" id="confirmTransactionImport" class="btn" onclick="confirmTransactionImport()">Import</button></div>',
      "</div></div></div>"
    ].join(""));
  }

  window.prepareTransactionImport = function (event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const items = Array.isArray(parsed) ? parsed : parsed.transactions;
        if (!Array.isArray(items) || !items.length) throw new Error("No transactions");
        const validDate = /^\d{4}-\d{2}-\d{2}$/;
        pendingImports = items.map((item, index) => {
          const amount = Number(item.amount);
          const description = normalizeText(item.description || item.name || item.merchant);
          if (!validDate.test(String(item.date || "")) || !Number.isFinite(amount) || amount === 0 || !description) {
            throw new Error("Invalid transaction at item " + (index + 1));
          }
          return {
            date: String(item.date),
            description,
            merchant: normalizeText(item.merchant || ""),
            amount,
            status: normalizeText(item.status || ""),
            notes: normalizeText(item.notes || "")
          };
        });
        el("importAccount").innerHTML = data.accounts.map(account => '<option value="' + account.id + '">' + esc(account.name) + "</option>").join("");
        el("importCategory").innerHTML = data.categories.map(category => '<option value="' + category.id + '">' + category.icon + " " + esc(category.name) + "</option>").join("");
        el("importPreview").innerHTML = pendingImports.slice(0, 50).map(item =>
          '<div class="row"><div><b>' + esc(item.description) + '</b><div class="muted">' + fmtDate(item.date) +
          (item.status ? " · " + esc(item.status) : "") + '</div></div><div class="amount ' +
          (item.amount < 0 ? "green" : "red") + '">' + (item.amount < 0 ? "+" : "−") + money(Math.abs(item.amount)) + "</div></div>"
        ).join("") + (pendingImports.length > 50 ? '<div class="muted">Previewing the first 50 transactions.</div>' : "");
        el("importSummary").textContent = pendingImports.length + " transaction" + (pendingImports.length === 1 ? "" : "s") +
          " ready. Negative amounts will be imported as income/refunds.";
        el("confirmTransactionImport").disabled = false;
        el("transactionImportModal").classList.add("open");
      } catch (error) {
        pendingImports = [];
        alert("Invalid transaction file. Use a JSON array with date, description, and non-zero amount fields.");
      }
    };
    reader.readAsText(file);
  };

  window.closeTransactionImport = function () {
    pendingImports = [];
    el("transactionImportModal").classList.remove("open");
  };

  window.confirmTransactionImport = function () {
    const account = el("importAccount").value;
    const category = el("importCategory").value;
    const existing = new Set(data.transactions.map(transactionFingerprint));
    let imported = 0;
    let skipped = 0;
    pendingImports.forEach(item => {
      const transaction = {
        id: crypto.randomUUID(),
        type: item.amount < 0 ? "income" : "expense",
        amount: Math.abs(item.amount),
        description: item.description,
        merchant: item.merchant,
        category,
        account,
        date: item.date,
        recurring: "oneoff",
        notes: [item.notes, item.status ? "Imported status: " + item.status : ""].filter(Boolean).join(" · ")
      };
      const fingerprint = transactionFingerprint(transaction);
      if (existing.has(fingerprint)) {
        skipped++;
        return;
      }
      existing.add(fingerprint);
      data.transactions.push(transaction);
      imported++;
    });
    save();
    closeTransactionImport();
    render();
    alert("Imported " + imported + " transaction" + (imported === 1 ? "" : "s") +
      (skipped ? ". Skipped " + skipped + " duplicate" + (skipped === 1 ? "" : "s") + "." : "."));
  };

  const originalOpenAccount = openAccount;
  openAccount = function (id) {
    editingAccountId = typeof id === "string" ? id : null;
    if (!editingAccountId) {
      originalOpenAccount();
      el("accountModal").querySelector("h2").textContent = "Add account";
      el("accType").disabled = false;
      return;
    }
    const account = data.accounts.find(item => item.id === editingAccountId);
    if (!account) return;
    el("accountModal").classList.add("open");
    el("accountModal").querySelector("h2").textContent = "Edit account";
    el("accName").value = account.name;
    el("accType").value = account.type || "bank";
    el("accType").disabled = true;
    el("accBalance").value = Number(account.opening || 0);
    syncAccountForm();
  };

  saveAccount = function (event) {
    event.preventDefault();
    const name = el("accName").value.trim();
    const opening = Math.abs(Number(el("accBalance").value || 0));
    if (editingAccountId) {
      const account = data.accounts.find(item => item.id === editingAccountId);
      if (account) {
        account.name = name;
        account.opening = opening;
      }
    } else {
      data.accounts.push({
        id: crypto.randomUUID(),
        name,
        type: el("accType").value,
        opening
      });
    }
    editingAccountId = null;
    el("accType").disabled = false;
    save();
    closeModal("accountModal");
    render();
  };

  const baseRenderSettings = renderSettings;
  renderSettings = function () {
    baseRenderSettings();
    el("settingsAccounts").innerHTML = data.accounts.map(account =>
      '<div class="row"><span><b>' + esc(account.name) + '</b><br><span class="account-type ' +
      account.type + '">' + ({ bank: "Bank Account", credit: "Credit Card", cash: "Cash" }[account.type] || "Bank Account") +
      '</span><br><span class="muted">Opening ' + money(account.opening) + '</span></span><span>' +
      '<button class="btn small secondary" onclick="openAccount(\'' + account.id + '\')">Edit</button> ' +
      '<button class="btn small danger" onclick="deleteAccount(\'' + account.id + '\')">Delete</button></span></div>'
    ).join("");
  };

  installImportUi();
  renderSettings();
})();


/* Account transaction history upgrade. */
(function () {
  let activeAccountHistoryId = null;

  function installAccountHistoryUi() {
    const style = document.createElement("style");
    style.textContent = ".account-history-row{cursor:pointer;border-radius:14px;padding-left:8px;padding-right:8px}.account-history-row:active{background:rgba(10,132,255,.08)}";
    document.head.appendChild(style);
    document.body.insertAdjacentHTML("beforeend", [
      '<div id="accountHistoryModal" class="modal" onclick="if(event.target===this)closeAccountHistory()">',
      '<div class="sheet"><h2 id="accountHistoryTitle">Account transactions</h2>',
      '<div id="accountHistorySummary" class="notice"></div>',
      '<div id="accountHistoryList" class="list"></div>',
      '<div class="actions"><button type="button" class="btn secondary" onclick="closeAccountHistory()">Close</button></div>',
      "</div></div>"
    ].join(""));
  }

  window.openAccountHistory = function (accountId) {
    const account = data.accounts.find(item => item.id === accountId);
    if (!account) return;
    activeAccountHistoryId = accountId;
    const transactions = data.transactions
      .filter(transaction => transaction.account === accountId || transaction.toAccount === accountId)
      .sort(window.transactionNewestFirst);
    el("accountHistoryTitle").textContent = account.name;
    el("accountHistorySummary").textContent = transactions.length + " transaction" +
      (transactions.length === 1 ? "" : "s") + " associated with this account.";
    el("accountHistoryList").innerHTML = transactions.length
      ? transactions.map(transaction => {
          let html = txHtml(transaction, true)
            .replace(
              "onclick=\"editTx('" + transaction.id + "')\"",
              "onclick=\"editAccountHistoryTransaction('" + transaction.id + "')\""
            )
            .replace(
              "onclick=\"deleteTx('" + transaction.id + "')\"",
              "onclick=\"deleteAccountHistoryTransaction('" + transaction.id + "')\""
            );
          if (transaction.type !== "transfer") return html;
          const sending = transaction.account === accountId;
          return html.replace(
            '<div class="amount ">' + money(transaction.amount) + "</div>",
            '<div class="amount ' + (sending ? "red" : "green") + '">' +
              (sending ? "−" : "+") + money(transaction.amount) + "</div>"
          );
        }).join("")
      : '<div class="empty">No transactions for this account yet.</div>';
    el("accountHistoryModal").classList.add("open");
  };

  window.closeAccountHistory = function () {
    activeAccountHistoryId = null;
    el("accountHistoryModal").classList.remove("open");
  };

  window.editAccountHistoryTransaction = function (transactionId) {
    closeAccountHistory();
    editTx(transactionId);
  };

  window.deleteAccountHistoryTransaction = function (transactionId) {
    if (!confirm("Delete this transaction?")) return;
    const accountId = activeAccountHistoryId;
    data.transactions = data.transactions.filter(transaction => transaction.id !== transactionId);
    save();
    render();
    if (accountId) openAccountHistory(accountId);
  };

  const baseRenderAccounts = renderAccounts;
  renderAccounts = function () {
    baseRenderAccounts();
    [...el("accountList").children].forEach((row, index) => {
      const account = data.accounts[index];
      if (!account) return;
      row.classList.add("account-history-row");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-label", "View transactions for " + account.name);
      row.onclick = () => openAccountHistory(account.id);
      row.onkeydown = event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openAccountHistory(account.id);
        }
      };
    });
  };

  installAccountHistoryUi();
  renderAccounts();
})();


/* Recurring management and amount search upgrade. */
(function () {
  let amountSearch = "";

  function recurringSkipKey(transaction) {
    return transaction.generatedFrom + "|" + transaction.date;
  }

  function ensureRecurringSkips() {
    if (!Array.isArray(data.recurringSkips)) data.recurringSkips = [];
  }

  function removeTransactionWithRecurringProtection(transactionId) {
    const transaction = data.transactions.find(item => item.id === transactionId);
    if (!transaction) return false;
    ensureRecurringSkips();
    if (transaction.generatedFrom) {
      const key = recurringSkipKey(transaction);
      if (!data.recurringSkips.includes(key)) data.recurringSkips.push(key);
    }
    data.transactions = data.transactions.filter(item => item.id !== transactionId);
    save();
    return true;
  }

  processRecurring = function () {
    ensureRecurringSkips();
    const todayStr = today();
    let added = 0;
    const skips = new Set(data.recurringSkips);
    const templates = data.transactions.filter(transaction =>
      transaction.recurring && transaction.recurring !== "oneoff" && !transaction.generatedFrom
    );
    for (const template of templates) {
      for (let index = 1; index < 5000; index++) {
        const due = nextRecurringDate(template.date, template.recurring, index);
        if (!due || due > todayStr) break;
        const key = template.id + "|" + due;
        if (skips.has(key)) continue;
        const exists = data.transactions.some(item => item.generatedFrom === template.id && item.date === due);
        if (!exists) {
          data.transactions.push({
            ...template,
            id: crypto.randomUUID(),
            date: due,
            recurring: "oneoff",
            generatedFrom: template.id,
            autoPosted: true
          });
          added++;
        }
      }
    }
    if (added) save();
    return added;
  };

  deleteTx = function (transactionId) {
    if (!confirm("Delete this transaction?")) return;
    removeTransactionWithRecurringProtection(transactionId);
    render();
  };

  deleteAccountHistoryTransaction = function (transactionId) {
    if (!confirm("Delete this transaction?")) return;
    const accountId = document.getElementById("accountHistoryModal").classList.contains("open")
      ? data.accounts.find(account => {
          const title = el("accountHistoryTitle").textContent;
          return account.name === title;
        })?.id
      : null;
    removeTransactionWithRecurringProtection(transactionId);
    render();
    if (accountId) openAccountHistory(accountId);
  };

  function installRecurringManagementUi() {
    const transactionsHeading = document.querySelector("#transactions .section-title");
    transactionsHeading.insertAdjacentHTML("afterend",
      '<div class="card" style="margin-bottom:12px"><label class="muted" for="amountSearch">Search expenses by amount</label>' +
      '<input id="amountSearch" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Enter an amount, e.g. 25.30" ' +
      'style="width:100%;margin-top:7px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--text)" ' +
      'oninput="setAmountSearch(this.value)"></div>'
    );

    const settingsCard = document.querySelector("#settings .card");
    const backupHeading = [...settingsCard.querySelectorAll("h3")].find(node => node.textContent.trim() === "Backup & restore");
    backupHeading.insertAdjacentHTML("beforebegin", [
      "<hr><h3>Automatic postings</h3>",
      '<div class="muted">Review recurring schedules and the occurrences posted automatically.</div>',
      '<div class="actions"><button class="btn secondary" onclick="openRecurringManager()">Manage automatic postings</button></div>'
    ].join(""));

    document.body.insertAdjacentHTML("beforeend", [
      '<div id="recurringManagerModal" class="modal" onclick="if(event.target===this)closeRecurringManager()">',
      '<div class="sheet"><h2>Automatic postings</h2>',
      '<div id="recurringManagerSummary" class="notice"></div>',
      '<div id="recurringManagerList" class="list"></div>',
      '<div class="actions"><button type="button" class="btn secondary" onclick="closeRecurringManager()">Close</button></div>',
      "</div></div>"
    ].join(""));
  }

  window.setAmountSearch = function (value) {
    amountSearch = String(value || "").trim();
    renderTx();
  };

  const previousRenderTx = renderTx;
  renderTx = function () {
    previousRenderTx();
    if (!amountSearch) return;
    const target = Number(amountSearch);
    if (!Number.isFinite(target)) return;
    let items = [...data.transactions]
      .filter(transaction => transaction.type === "expense" && Math.abs(Number(transaction.amount) - target) < 0.005)
      .sort(window.transactionNewestFirst);
    el("txList").innerHTML = items.length
      ? items.map(transaction => txHtml(transaction, true)).join("")
      : '<div class="empty">No expenses found for ' + money(target) + ".</div>";
  };

  window.openRecurringManager = function () {
    const items = data.transactions
      .filter(transaction => (transaction.recurring && transaction.recurring !== "oneoff") || transaction.autoPosted)
      .sort(window.transactionNewestFirst);
    const schedules = items.filter(transaction => !transaction.generatedFrom).length;
    const postedItems = items.filter(transaction => transaction.autoPosted).length;
    el("recurringManagerSummary").textContent =
      schedules + " active recurring schedule" + (schedules === 1 ? "" : "s") + " · " +
      postedItems + " auto-posted item" + (postedItems === 1 ? "" : "s");
    el("recurringManagerList").innerHTML = items.length
      ? items.map(transaction => txHtml(transaction, true)
          .replace(
            "onclick=\"editTx('" + transaction.id + "')\"",
            "onclick=\"editRecurringItem('" + transaction.id + "')\""
          )
          .replace(
            "onclick=\"deleteTx('" + transaction.id + "')\"",
            "onclick=\"deleteRecurringItem('" + transaction.id + "')\""
          )
        ).join("")
      : '<div class="empty">No recurring schedules or auto-posted items.</div>';
    el("recurringManagerModal").classList.add("open");
  };

  window.closeRecurringManager = function () {
    el("recurringManagerModal").classList.remove("open");
  };

  window.editRecurringItem = function (transactionId) {
    closeRecurringManager();
    editTx(transactionId);
  };

  window.deleteRecurringItem = function (transactionId) {
    if (!confirm("Delete this automatic posting?")) return;
    removeTransactionWithRecurringProtection(transactionId);
    render();
    openRecurringManager();
  };

  ensureRecurringSkips();
  installRecurringManagementUi();
})();

+
/* Year/month report filters and consolidated annual chart. */
(function () {
  const now = new Date();
  let reportYear = now.getFullYear();
  let reportMonth = String(now.getMonth() + 1).padStart(2, "0");
  const MONTHS = Array.from({ length: 12 }, (_, index) =>
    new Date(2000, index, 1).toLocaleDateString("en-GB", { month: "short" })
  );

  function installReportStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .report-filters{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
      .report-filter{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.035em}
      .report-filter select{width:100%;padding:12px 13px;margin-top:6px;border:1px solid var(--line);border-radius:13px;background:var(--bg);color:var(--text);outline:none}
      .report-filter select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(10,132,255,.12)}
      .annual-legend{display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 8px;color:var(--muted);font-size:12px;font-weight:650}
      .annual-legend span{display:inline-flex;align-items:center;gap:6px}
      .annual-key{width:12px;height:8px;border-radius:3px;display:inline-block}
      .annual-key.income{background:var(--green)}.annual-key.expense{background:var(--red)}
      .annual-key.net{height:3px;background:var(--accent)}
      .annual-chart-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
      .annual-chart{display:block;width:100%;min-width:720px;height:auto;color:var(--text)}
      .annual-chart text{fill:var(--muted);font-size:11px;font-family:inherit}
      .annual-chart .grid-line{stroke:var(--line);stroke-width:1}
      .annual-chart .axis-line{stroke:var(--muted);stroke-width:1}
      .annual-chart .income-bar{fill:var(--green)}.annual-chart .expense-bar{fill:var(--red)}
      .annual-chart .net-line{fill:none;stroke:var(--accent);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}
      .annual-chart .net-dot{fill:var(--card);stroke:var(--accent);stroke-width:3}
      .annual-note{margin-top:6px}
      @media(max-width:520px){.report-filters{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function installReportUi() {
    const card = document.querySelector("#reports > .card");
    card.innerHTML = `
      <div class="report-filters">
        <label class="report-filter">Year<select id="reportYear" onchange="setReportYear(this.value)"></select></label>
        <label class="report-filter">Month<select id="reportMonth" onchange="setReportMonth(this.value)">
          <option value="all">All months</option>
          ${MONTHS.map((month, index) => `<option value="${String(index + 1).padStart(2, "0")}">${month}</option>`).join("")}
        </select></label>
      </div>
      <div id="reportSummary" class="grid"></div>
      <div class="section-title"><h2>Annual overview</h2><span id="annualChartYear" class="muted"></span></div>
      <div class="annual-legend" aria-label="Chart legend">
        <span><i class="annual-key income"></i>Income</span>
        <span><i class="annual-key expense"></i>Expenses</span>
        <span><i class="annual-key net"></i>Month-end net worth</span>
      </div>
      <div id="annualChart" class="annual-chart-scroll"></div>
      <div class="muted annual-note">Net worth is measured on the last day of completed months. The annual chart follows the year filter only.</div>
      <div class="section-title"><h2 id="trendTitle">Spending trend</h2><span id="reportPeriodLabel" class="muted"></span></div>
      <div id="trend" class="chart"></div>
      <div class="section-title"><h2>Categories</h2></div><div id="reportCats"></div>
      <div class="section-title"><h2>Spending by merchant</h2></div><div id="reportMerchants"></div>`;
  }

  function availableYears() {
    const years = new Set([now.getFullYear()]);
    data.transactions.forEach(transaction => {
      const year = Number(String(transaction.date || "").slice(0, 4));
      if (Number.isInteger(year)) years.add(year);
    });
    return [...years].sort((a, b) => b - a);
  }

  function syncReportControls() {
    const yearSelect = el("reportYear");
    yearSelect.innerHTML = availableYears().map(year =>
      `<option value="${year}">${year}</option>`
    ).join("");
    yearSelect.value = String(reportYear);
    el("reportMonth").value = reportMonth;
  }

  function isReportable(transaction) {
    return transaction.type !== "transfer" && transaction.date <= today();
  }

  function filteredReportTransactions() {
    const yearPrefix = String(reportYear) + "-";
    const monthPrefix = reportMonth === "all" ? yearPrefix : yearPrefix + reportMonth + "-";
    return data.transactions.filter(transaction =>
      isReportable(transaction) && transaction.date.startsWith(monthPrefix)
    );
  }

  function reportAccountDelta(transaction, account) {
    const amount = Number(transaction.amount);
    if (transaction.type === "transfer") {
      if (transaction.account === account.id) return account.type === "credit" ? amount : -amount;
      if (transaction.toAccount === account.id) return account.type === "credit" ? -amount : amount;
      return 0;
    }
    if (transaction.account !== account.id) return 0;
    if (transaction.type === "expense") return account.type === "credit" ? amount : -amount;
    return account.type === "credit" ? -amount : amount;
  }

  function netWorthAt(cutoff) {
    return data.accounts.reduce((total, account) => {
      const balance = Number(account.opening || 0) + data.transactions
        .filter(transaction =>
          transaction.date <= cutoff &&
          (transaction.account === account.id || transaction.toAccount === account.id)
        )
        .reduce((sum, transaction) => sum + reportAccountDelta(transaction, account), 0);
      return total + (account.type === "credit" ? -balance : balance);
    }, 0);
  }

  function compactMoney(value) {
    const absolute = Math.abs(value);
    if (absolute >= 1000000) return "£" + (value / 1000000).toFixed(1) + "m";
    if (absolute >= 1000) return "£" + (value / 1000).toFixed(1) + "k";
    return "£" + Math.round(value);
  }

  function annualData() {
    return MONTHS.map((label, index) => {
      const month = String(index + 1).padStart(2, "0");
      const prefix = reportYear + "-" + month + "-";
      const transactions = data.transactions.filter(transaction =>
        isReportable(transaction) && transaction.date.startsWith(prefix)
      );
      const income = transactions.filter(transaction => transaction.type === "income")
        .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
      const expense = transactions.filter(transaction => transaction.type === "expense")
        .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
      const monthEndDate = new Date(reportYear, index + 1, 0);
      const completed = monthEndDate < new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const cutoff = [reportYear, month, String(monthEndDate.getDate()).padStart(2, "0")].join("-");
      return { label, income, expense, netWorth: completed ? netWorthAt(cutoff) : null };
    });
  }

  function renderAnnualChart() {
    const values = annualData();
    const width = 840, height = 330;
    const margin = { top: 20, right: 70, bottom: 42, left: 66 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const baseline = margin.top + plotHeight;
    const groupWidth = plotWidth / 12;
    const barWidth = Math.min(18, groupWidth * 0.3);
    const flowMax = Math.max(1, ...values.flatMap(item => [item.income, item.expense]));
    const netValues = values.map(item => item.netWorth).filter(value => value !== null);
    let netMin = netValues.length ? Math.min(...netValues) : 0;
    let netMax = netValues.length ? Math.max(...netValues) : 1;
    if (netMin === netMax) {
      const padding = Math.max(Math.abs(netMin) * 0.1, 1);
      netMin -= padding; netMax += padding;
    } else {
      const padding = (netMax - netMin) * 0.08;
      netMin -= padding; netMax += padding;
    }
    const flowY = value => baseline - (value / flowMax) * plotHeight;
    const netY = value => margin.top + (netMax - value) / (netMax - netMin) * plotHeight;
    const centreX = index => margin.left + groupWidth * index + groupWidth / 2;
    const grid = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      const y = margin.top + ratio * plotHeight;
      const flowValue = flowMax * (1 - ratio);
      const netValue = netMax - (netMax - netMin) * ratio;
      return `<line class="grid-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"/>
        <text x="${margin.left - 8}" y="${y + 4}" text-anchor="end">${compactMoney(flowValue)}</text>
        <text x="${width - margin.right + 8}" y="${y + 4}" text-anchor="start">${compactMoney(netValue)}</text>`;
    }).join("");
    const bars = values.map((item, index) => {
      const x = centreX(index);
      const incomeY = flowY(item.income), expenseY = flowY(item.expense);
      return `<rect class="income-bar" x="${x - barWidth - 2}" y="${incomeY}" width="${barWidth}" height="${Math.max(0, baseline - incomeY)}" rx="3">
          <title>${item.label} income: ${money(item.income)}</title></rect>
        <rect class="expense-bar" x="${x + 2}" y="${expenseY}" width="${barWidth}" height="${Math.max(0, baseline - expenseY)}" rx="3">
          <title>${item.label} expenses: ${money(item.expense)}</title></rect>`;
    }).join("");
    const points = values.map((item, index) =>
      item.netWorth === null ? null : { x: centreX(index), y: netY(item.netWorth), ...item }
    ).filter(Boolean);
    const line = points.length
      ? `<polyline class="net-line" points="${points.map(point => point.x + "," + point.y).join(" ")}"/>` : "";
    const dots = points.map(point =>
      `<circle class="net-dot" cx="${point.x}" cy="${point.y}" r="4">
        <title>${point.label} month-end net worth: ${money(point.netWorth)}</title></circle>`
    ).join("");
    const monthLabels = values.map((item, index) =>
      `<text x="${centreX(index)}" y="${height - 16}" text-anchor="middle">${item.label}</text>`
    ).join("");
    el("annualChart").innerHTML = `<svg class="annual-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="annualChartTitle annualChartDesc">
      <title id="annualChartTitle">${reportYear} income, expenses and month-end net worth</title>
      <desc id="annualChartDesc">Monthly income and expense bars with a line showing net worth on the last day of each completed month.</desc>
      ${grid}
      <line class="axis-line" x1="${margin.left}" y1="${baseline}" x2="${width - margin.right}" y2="${baseline}"/>
      <text x="16" y="${margin.top + plotHeight / 2}" transform="rotate(-90 16 ${margin.top + plotHeight / 2})" text-anchor="middle">Monthly flow</text>
      <text x="${width - 12}" y="${margin.top + plotHeight / 2}" transform="rotate(90 ${width - 12} ${margin.top + plotHeight / 2})" text-anchor="middle">Month-end net worth</text>
      ${bars}${line}${dots}${monthLabels}
    </svg>`;
    el("annualChartYear").textContent = String(reportYear);
  }

  function renderSummary(transactions) {
    const income = transactions.filter(transaction => transaction.type === "income")
      .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
    const expense = transactions.filter(transaction => transaction.type === "expense")
      .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
    el("reportSummary").innerHTML = `
      <div class="card stat"><div class="label">Income</div><div class="value green">${money(income)}</div></div>
      <div class="card stat"><div class="label">Spent</div><div class="value red">${money(expense)}</div></div>
      <div class="card stat"><div class="label">Net</div><div class="value">${money(income - expense)}</div></div>
      <div class="card stat"><div class="label">Transactions</div><div class="value">${transactions.length}</div></div>`;
  }

  function renderSelectedTrend(transactions) {
    const allMonths = reportMonth === "all";
    const bucketCount = allMonths ? 12 : new Date(reportYear, Number(reportMonth), 0).getDate();
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      label: allMonths ? MONTHS[index] : String(index + 1),
      value: 0
    }));
    transactions.filter(transaction => transaction.type === "expense").forEach(transaction => {
      const index = allMonths ? Number(transaction.date.slice(5, 7)) - 1 : Number(transaction.date.slice(8, 10)) - 1;
      if (buckets[index]) buckets[index].value += Number(transaction.amount);
    });
    const max = Math.max(1, ...buckets.map(bucket => bucket.value));
    el("trend").innerHTML = buckets.map(bucket =>
      `<div class="col"><i style="height:${Math.max(2, bucket.value / max * 100)}%" title="${esc(bucket.label)}: ${money(bucket.value)}"></i><span>${esc(bucket.label)}</span></div>`
    ).join("");
    el("trendTitle").textContent = allMonths ? "Monthly spending" : "Daily spending";
  }

  function renderBreakdowns(transactions) {
    const categories = {};
    const merchants = {};
    transactions.filter(transaction => transaction.type === "expense").forEach(transaction => {
      categories[transaction.category] = (categories[transaction.category] || 0) + Number(transaction.amount);
      const merchant = (transaction.merchant || "").trim() || "Unspecified merchant";
      merchants[merchant] = (merchants[merchant] || 0) + Number(transaction.amount);
    });
    const categoryRows = Object.entries(categories).sort((a, b) => b[1] - a[1]);
    el("reportCats").innerHTML = categoryRows.length ? categoryRows.map(([id, value]) => {
      const category = getCat(id);
      return `<div class="row"><span>${category.icon} ${esc(category.name)}</span><b>${money(value)}</b></div>`;
    }).join("") : `<div class="empty">No spending in this period</div>`;
    const merchantRows = Object.entries(merchants).sort((a, b) => b[1] - a[1]);
    el("reportMerchants").innerHTML = merchantRows.length ? merchantRows.map(([merchant, value]) =>
      `<div class="row"><span>🏪 ${esc(merchant)}</span><b>${money(value)}</b></div>`
    ).join("") : `<div class="empty">No merchant spending in this period</div>`;
  }

  window.setReportYear = function (value) {
    reportYear = Number(value);
    renderReports();
  };

  window.setReportMonth = function (value) {
    reportMonth = value;
    renderReports();
  };

  renderReports = function () {
    syncReportControls();
    const transactions = filteredReportTransactions();
    const period = reportMonth === "all"
      ? String(reportYear)
      : new Date(reportYear, Number(reportMonth) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    el("reportPeriodLabel").textContent = period;
    renderSummary(transactions);
    renderAnnualChart();
    renderSelectedTrend(transactions);
    renderBreakdowns(transactions);
  };

  installReportStyles();
  installReportUi();
  renderReports();
})();


