/* Server-side access to the shared message catalog (the browser loads the same files from /public). */
'use strict';
const I18n = require('../public/i18n.js');

['server', 'cli'].forEach(function(area)
{
  I18n.addMessages(require('../public/locales/' + area + '.js'));
});

// WAS_LANG wins, then the usual POSIX locale variables; anything else falls back to English.
function processLocale(env)
{
  const names = ['WAS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
  for (var index = 0; index < names.length; index++)
  {
    const locale = I18n.normalizeLocale(String((env || {})[names[index]] || '').split('.')[0]);
    if (locale) return locale;
  }
  return I18n.DEFAULT_LOCALE;
}

I18n.setLocale(processLocale(process.env));
I18n.processLocale = processLocale;
module.exports = I18n;
