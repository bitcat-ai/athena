// Test entry point: keep Electron windows invisible and unable to activate macOS.
const path = require('node:path');
const { app } = require('electron');

if (!process.env.WORKBENCH_USER_DATA_DIR) {
  console.error('Background tests require an isolated WORKBENCH_USER_DATA_DIR.');
  app.exit(1);
} else {
  const root = path.resolve(__dirname, '..');
  app.getAppPath = () => root;
  app.on('ready', () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  });
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    window.showInactive = () => {};
    window.focus = () => {};
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    window.webContents.setBackgroundThrottling(false);
  });
  require(path.join(root, 'dist/main/main.cjs'));
}
