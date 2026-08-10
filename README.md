# My Expenses PWA

A private, local-first personal expense tracker with Bank Account, Credit Card,
and Cash account types. All financial data stays in the browser on the device.

## Publish on GitHub Pages

1. Upload every file in this folder to the root of your
   `personal_expense_tracker` repository.
2. In GitHub, open **Settings → Pages**.
3. Choose **Deploy from a branch**, select `main`, choose `/(root)`, and save.
4. Open `https://YOUR-USERNAME.github.io/personal_expense_tracker/` once while
   online. On iPhone, use Safari's **Share → Add to Home Screen**.

The service worker caches the complete app shell for offline use. Existing data
stored under `my-expenses-v2` is retained and migrated automatically: older
accounts are treated as Bank Accounts. Export a backup before replacing a
previous deployment as a precaution.

## Balance rules

- Bank and Cash expenses reduce the available balance; income increases it.
- Credit Card purchases increase the amount owed; refunds/income reduce it.
- Transfers move value between accounts. A Bank-to-Credit-Card transfer is a
  repayment and reduces both bank cash and card debt.
- Transfers never count as income or spending in reports.
- Net worth equals Bank and Cash balances minus Credit Card debt.
