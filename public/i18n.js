/* Minimal bilingual (en / ko) message catalog shared by the browser and Node. */
(function (root, factory)
{
  var api = factory(root);
  if (typeof module === "object" && module.exports)
  {
    module.exports = api;
  }
  else
  {
    root.WasI18n = api;
  }
})(typeof self !== "undefined" ? self : this, function (root)
{
  "use strict";

  var SUPPORTED = ["en", "ko"];
  var DEFAULT_LOCALE = "en";
  var LOCALE_TAGS = { en: "en-US", ko: "ko-KR" };
  var STORAGE_KEY = "was_observatory_locale";
  var TOKEN_OPEN = "⟦";
  var TOKEN_CLOSE = "⟧";
  var TOKEN_PATTERN = /⟦([A-Za-z0-9_.-]+)(?:\?([^⟦⟧]*))?⟧/g;
  var PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;
  var DOM_BINDINGS = [
    { attribute: "data-i18n", target: "" },
    { attribute: "data-i18n-title", target: "title" },
    { attribute: "data-i18n-aria-label", target: "aria-label" },
    { attribute: "data-i18n-placeholder", target: "placeholder" }
  ];

  var catalogs = { en: {}, ko: {} };
  var current = DEFAULT_LOCALE;
  var listeners = [];
  var missing = {};

  function normalizeLocale(value)
  {
    var text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (text === "ko" || text.indexOf("ko-") === 0 || text.indexOf("ko_") === 0)
    {
      return "ko";
    }
    if (text === "en" || text.indexOf("en-") === 0 || text.indexOf("en_") === 0)
    {
      return "en";
    }
    return null;
  }

  // parts is { en: { key: message }, ko: { key: message } }; a message is a string or a plural object.
  function addMessages(parts)
  {
    SUPPORTED.forEach(function (locale)
    {
      var source = (parts && parts[locale]) || {};
      Object.keys(source).forEach(function (key)
      {
        if (Object.prototype.hasOwnProperty.call(catalogs[locale], key) && JSON.stringify(catalogs[locale][key]) !== JSON.stringify(source[key]))
        {
          throw new Error("Duplicate i18n key with a different message: " + locale + ":" + key);
        }
        catalogs[locale][key] = source[key];
      });
    });
  }

  function lookup(locale, key)
  {
    if (Object.prototype.hasOwnProperty.call(catalogs[locale], key))
    {
      return catalogs[locale][key];
    }
    if (Object.prototype.hasOwnProperty.call(catalogs[DEFAULT_LOCALE], key))
    {
      return catalogs[DEFAULT_LOCALE][key];
    }
    return null;
  }

  function pluralCategory(locale, count)
  {
    try
    {
      return new Intl.PluralRules(LOCALE_TAGS[locale]).select(Number(count));
    }
    catch (error)
    {
      return "other";
    }
  }

  function format(template, params)
  {
    return template.replace(PLACEHOLDER_PATTERN, function (match, name)
    {
      return params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match;
    });
  }

  // Translates key for an explicit locale. A message object picks its form by params.count.
  function translate(locale, key, params)
  {
    var target = normalizeLocale(locale) || current;
    var message = lookup(target, key);
    if (message === null)
    {
      missing[key] = true;
      return key;
    }
    if (typeof message === "object")
    {
      message = message[pluralCategory(target, params && params.count)] || message.other || key;
    }
    return format(message, params);
  }

  function t(key, params)
  {
    return translate(current, key, params);
  }

  // A message token carries a key and parameters inside an ordinary string, so the server can send
  // text that the client later renders in the viewer's language (see resolve).
  function token(key, params)
  {
    var query = [];
    Object.keys(params || {}).forEach(function (name)
    {
      if (params[name] !== undefined && params[name] !== null)
      {
        query.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(params[name])));
      }
    });
    return TOKEN_OPEN + key + (query.length ? "?" + query.join("&") : "") + TOKEN_CLOSE;
  }

  function decode(text)
  {
    try
    {
      return decodeURIComponent(text);
    }
    catch (error)
    {
      return text;
    }
  }

  function resolve(text, locale)
  {
    if (typeof text !== "string" || text.indexOf(TOKEN_OPEN) < 0)
    {
      return text;
    }
    var target = normalizeLocale(locale) || current;
    return text.replace(TOKEN_PATTERN, function (match, key, query)
    {
      if (lookup(target, key) === null)
      {
        missing[key] = true;
        return match;
      }
      var params = {};
      (query ? query.split("&") : []).forEach(function (pair)
      {
        var at = pair.indexOf("=");
        params[decode(at < 0 ? pair : pair.slice(0, at))] = resolve(at < 0 ? "" : decode(pair.slice(at + 1)), target);
      });
      return translate(target, key, params);
    });
  }

  // Returns a copy of a JSON-like value with every message token rendered.
  function resolveDeep(value, locale)
  {
    if (typeof value === "string")
    {
      return resolve(value, locale);
    }
    if (Array.isArray(value))
    {
      return value.map(function (item) { return resolveDeep(item, locale); });
    }
    if (value && typeof value === "object")
    {
      var copy = {};
      Object.keys(value).forEach(function (name) { copy[name] = resolveDeep(value[name], locale); });
      return copy;
    }
    return value;
  }

  // Text that comes from observed records must not be able to forge a message token.
  function stripMarkers(text)
  {
    return String(text).replace(/⟦/g, "[").replace(/⟧/g, "]");
  }

  function getLocale()
  {
    return current;
  }

  function setLocale(locale)
  {
    var next = normalizeLocale(locale);
    if (!next || next === current)
    {
      return current;
    }
    current = next;
    listeners.slice().forEach(function (listener) { listener(current); });
    return current;
  }

  function onChange(listener)
  {
    listeners.push(listener);
  }

  function formatNumber(value, locale)
  {
    return Number(value || 0).toLocaleString(LOCALE_TAGS[normalizeLocale(locale) || current]);
  }

  function formatDateTime(date, locale)
  {
    return date.toLocaleString(LOCALE_TAGS[normalizeLocale(locale) || current], { hour12: false });
  }

  // sources: { query, stored, languages } in priority order; anything unsupported falls through.
  function detectLocale(sources)
  {
    var input = sources || {};
    var candidates = [input.query, input.stored].concat(input.languages || []);
    for (var index = 0; index < candidates.length; index++)
    {
      var locale = normalizeLocale(candidates[index]);
      if (locale)
      {
        return locale;
      }
    }
    return DEFAULT_LOCALE;
  }

  function detectBrowserLocale()
  {
    var sources = { languages: [] };
    try
    {
      var match = /[?&]lang=([^&#]*)/.exec(root.location.search);
      sources.query = match ? decode(match[1]) : undefined;
    }
    catch (error) {}
    try
    {
      sources.stored = root.localStorage.getItem(STORAGE_KEY);
    }
    catch (error) {}
    try
    {
      sources.languages = root.navigator.languages && root.navigator.languages.length ? Array.from(root.navigator.languages) : [root.navigator.language];
    }
    catch (error) {}
    return detectLocale(sources);
  }

  function persistLocale(locale)
  {
    try
    {
      root.localStorage.setItem(STORAGE_KEY, locale);
    }
    catch (error) {}
  }

  // Renders data-i18n, data-i18n-title, data-i18n-aria-label and data-i18n-placeholder markup.
  function applyDom(scope)
  {
    DOM_BINDINGS.forEach(function (binding)
    {
      Array.from(scope.querySelectorAll("[" + binding.attribute + "]")).forEach(function (element)
      {
        var text = t(element.getAttribute(binding.attribute));
        if (binding.target)
        {
          element.setAttribute(binding.target, text);
        }
        else
        {
          element.textContent = text;
        }
      });
    });
    var documentElement = (scope.ownerDocument || scope).documentElement;
    if (documentElement)
    {
      documentElement.setAttribute("lang", current);
    }
  }

  return {
    SUPPORTED: SUPPORTED,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    addMessages: addMessages,
    normalizeLocale: normalizeLocale,
    detectLocale: detectLocale,
    detectBrowserLocale: detectBrowserLocale,
    persistLocale: persistLocale,
    getLocale: getLocale,
    setLocale: setLocale,
    onChange: onChange,
    t: t,
    translate: translate,
    token: token,
    resolve: resolve,
    resolveDeep: resolveDeep,
    stripMarkers: stripMarkers,
    formatNumber: formatNumber,
    formatDateTime: formatDateTime,
    applyDom: applyDom,
    catalogs: catalogs,
    missingKeys: function () { return Object.keys(missing); }
  };
});
