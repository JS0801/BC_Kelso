/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * BlueCollar Submittals — project sub-tab SPA host Suitelet.
 *
 * Same bundle as bc_spa_host_sl but with a pre-bundle bootstrap script
 * that sets window.__bcEmbed = true (so the SPA renders the compressed
 * app bar variant) and window.__bcProjectId = ?projectId. The SPA reads
 * those globals at boot to scope itself to the embedding project.
 */
define(['N/log', 'N/file', 'N/runtime', 'N/url'], (log, file, runtime, url) => {

  const JS_PATH  = 'SuiteScripts/BlueCollarSubmittals/spa/assets/app.js';
  const CSS_PATH = 'SuiteScripts/BlueCollarSubmittals/spa/assets/index.css';

  const escapeForJs = (s) => String(s == null ? '' : s).replace(/[\\"'<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

  // User's NS date-format mask (e.g. "M/D/YYYY"), read from the current
  // user's preferences. runtime.getCurrentUser().getPreference is the
  // supported path — N/config USER_PREFERENCES.getValue('dateformat')
  // returns empty in this account.
  const resolveDateFormat = () => {
    try {
      const fmt = runtime.getCurrentUser().getPreference({ name: 'DATEFORMAT' });
      log.audit({ title: 'bc_spa_tab_sl: dateformat', details: `resolved=${fmt}` });
      return fmt || '';
    } catch (e) {
      log.error({ title: 'bc_spa_tab_sl: dateformat', details: e.message });
      return '';
    }
  };

  const renderShell = (cssText, jsText, projectId, restletUrl, mode, futureModules, dateFormat) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Submittals</title>
  <style>${cssText}</style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__bcEmbed = true;
    window.__bcProjectId = "${escapeForJs(projectId)}";
    window.__bcRestletUrl = "${escapeForJs(restletUrl)}";
    ${mode ? `window.__bcMode = "${escapeForJs(mode)}";` : ''}
    ${futureModules ? `window.__bcPmShowFutureModules = true;` : ''}
    ${dateFormat ? `window.__bcDateFormat = "${escapeForJs(dateFormat)}";` : ''}
  </script>
  <script>${jsText}</script>
</body>
</html>`;

  const onRequest = (context) => {
    const usageAtEntry = runtime.getCurrentScript().getRemainingUsage();
    try {
      const params = context.request.parameters || {};
      const projectId      = params.projectId || '';
      const mode           = params.mode || '';          // 'pm-overlay' when mounted via UE iframe
      const futureModules  = params.futureModules === '1';
      const cssText = file.load({ id: CSS_PATH }).getContents();
      const jsText  = file.load({ id: JS_PATH  }).getContents();
      const restletUrl = url.resolveScript({
        scriptId: 'customscript_bc_api_rl',
        deploymentId: 'customdeploy_bc_api_rl',
        returnExternalUrl: false
      });
      const dateFormat = resolveDateFormat();

      context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
      context.response.write(renderShell(cssText, jsText, projectId, restletUrl, mode, futureModules, dateFormat));

      const usageAtExit = runtime.getCurrentScript().getRemainingUsage();
      log.audit('governance', `bc_spa_tab_sl entry=${usageAtEntry} exit=${usageAtExit} consumed=${usageAtEntry - usageAtExit}`);
    } catch (e) {
      log.error({ title: `bc_spa_tab_sl: ${e.name}`, details: `${e.message}\n${e.stack}` });
      context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
      context.response.write(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
        <h1>SPA bundle missing or unreadable.</h1>
        <p>Run <code>npm run spa:build</code> then <code>npm run sdf:deploy</code>.</p>
        <pre style="background:#eef0f3;padding:12px;border-radius:6px">${e.message}</pre>
      </body></html>`);
    }
  };

  return { onRequest };
});
