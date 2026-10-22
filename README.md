# financials

MISMO Money's public sign-in shell, served at https://resources.mismo.org/financials/.

Code only, never data. This repository holds `index.html` and `shim.js` and nothing else of
MISMO Money. After sign-in, the shell reads the application and its records from the private
repository GitMISMO/financials-data through MISMO's save relay (project key `financials`).
Signed out, or without MISMO Money on the Initiative Hub admin screen, nothing reaches the browser.

Change the application in financials-data, not here. Before changing these two files, scan them:
no amounts, member or vendor names, email addresses, tokens or other secrets.
