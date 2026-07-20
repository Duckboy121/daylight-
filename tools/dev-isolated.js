// Dev-only entry point: run the launcher with a throwaway userData profile so
// a test instance never fights the installed app's single-instance lock and
// never reads or writes the real config. Usage:
//   npx electron tools/dev-isolated.js [--remote-debugging-port=9223]
const { app } = require('electron');
const path = require('path');
const os = require('os');

app.setPath('userData', path.join(os.tmpdir(), 'daylight-devtest'));
require(path.join(__dirname, '..', 'src', 'main.js'));
