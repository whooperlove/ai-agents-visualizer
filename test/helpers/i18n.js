'use strict';
const Fs = require('node:fs');
const Path = require('node:path');
const Vm = require('node:vm');

const PUBLIC_ROOT = Path.join(__dirname, '..', '..', 'public');
const AREAS = ['html', 'app', 'scene', 'server', 'cli'];

// Runs the browser catalog (core plus every locale part) inside a vm sandbox, the way index.html loads it.
// The sandbox is contextified in place, so run later scripts with Vm.runInContext(code, sandbox).
function loadBrowserI18n(sandbox, locale)
{
  Vm.createContext(sandbox);
  ['i18n.js'].concat(AREAS.map(function(area) { return 'locales/' + area + '.js'; })).forEach(function(file)
  {
    Vm.runInContext(Fs.readFileSync(Path.join(PUBLIC_ROOT, file), 'utf8'), sandbox, { filename: file });
  });
  sandbox.WasI18n.setLocale(locale || 'ko');
  return sandbox;
}

// A fresh Node-side catalog with all parts registered, independent of the process locale.
function loadNodeI18n()
{
  delete require.cache[require.resolve('../../public/i18n.js')];
  const I18n = require('../../public/i18n.js');
  AREAS.forEach(function(area) { I18n.addMessages(require('../../public/locales/' + area + '.js')); });
  return I18n;
}

module.exports = { AREAS: AREAS, PUBLIC_ROOT: PUBLIC_ROOT, loadBrowserI18n: loadBrowserI18n, loadNodeI18n: loadNodeI18n };
