/* Credit-card and transfer upgrade. Keeps the existing my-expenses-v2 data key. */
(function () {
  const ACCOUNT_TYPES = { bank: "Bank Account", credit: "Credit Card", cash: "Cash" };
  const uuid = () => crypto.randomUUID();
  const isCredit = account => account?.type === "credit";
  const posted = t => t.date <= today();

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
    return `<div class="row"><div class="left"><div class="icon">${c.icon}</div><div><b>${esc(t.description)}</b><div><span class="tx-kind ${kind}">${label}</span></div><div class="muted">${route} · ${fmtDate(t.date)}${tag}</div></div></div><div style="text-align:right"><div class="amount ${amountClass}">${sign}${money(t.amount)}</div>${actions ? `<button class="btn small secondary" onclick="editTx('${t.id}')">Edit</button> <button class="btn small danger" onclick="deleteTx('${t.id}')">Delete</button>` : ""}</div></div>`;
  };

  renderTx = function () {
    let items = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date));
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
