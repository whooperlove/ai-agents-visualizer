'use strict';
const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Helpers = require('./helpers/i18n');

const ROOT = Path.join(__dirname, '..');
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

function fresh()
{
  return Helpers.loadNodeI18n();
}

function placeholders(message)
{
  const text = typeof message === 'string' ? message : Object.keys(message).map(function(form) { return message[form]; }).join(' ');
  return Array.from(new Set((text.match(/\{[A-Za-z0-9_]+\}/g) || []))).sort();
}

function listFiles(directory, pattern)
{
  return Fs.readdirSync(Path.join(ROOT, directory)).filter(function(name) { return pattern.test(name); }).map(function(name) { return Path.join(directory, name); });
}

Test('locale detection prefers the query, then the stored choice, then browser languages', function()
{
  const I18n = fresh();
  Assert.equal(I18n.detectLocale({ query: 'ko', stored: 'en', languages: ['en-US'] }), 'ko');
  Assert.equal(I18n.detectLocale({ stored: 'en', languages: ['ko-KR'] }), 'en');
  Assert.equal(I18n.detectLocale({ languages: ['ja-JP', 'ko-KR'] }), 'ko');
  Assert.equal(I18n.detectLocale({ languages: ['fr-FR'] }), 'en');
  Assert.equal(I18n.detectLocale({ query: 'xx', languages: [] }), 'en');
  Assert.equal(I18n.detectLocale(), 'en');
});

Test('t fills placeholders, picks plural forms and falls back to English then to the key', function()
{
  const I18n = fresh();
  I18n.addMessages({
    en: { 'test.hello': 'Hello {name}', 'test.items': { one: '{count} item', other: '{count} items' }, 'test.onlyEn': 'English only' },
    ko: { 'test.hello': '안녕 {name}', 'test.items': { other: '{count}개' } }
  });
  Assert.equal(I18n.translate('en', 'test.hello', { name: 'Ada' }), 'Hello Ada');
  Assert.equal(I18n.translate('ko', 'test.hello', { name: 'Ada' }), '안녕 Ada');
  Assert.equal(I18n.translate('en', 'test.items', { count: 1 }), '1 item');
  Assert.equal(I18n.translate('en', 'test.items', { count: 2 }), '2 items');
  Assert.equal(I18n.translate('en', 'test.items', { count: 0 }), '0 items');
  Assert.equal(I18n.translate('ko', 'test.items', { count: 1 }), '1개');
  Assert.equal(I18n.translate('ko', 'test.onlyEn'), 'English only');
  Assert.equal(I18n.translate('en', 'test.hello'), 'Hello {name}', 'a missing parameter keeps its placeholder');
  Assert.equal(I18n.translate('en', 'test.unknown'), 'test.unknown');
  Assert.ok(I18n.missingKeys().includes('test.unknown'));
});

Test('addMessages rejects a different message under an existing key but allows an identical repeat', function()
{
  const I18n = fresh();
  I18n.addMessages({ en: { 'test.same': 'One' } });
  I18n.addMessages({ en: { 'test.same': 'One' } });
  Assert.throws(function() { I18n.addMessages({ en: { 'test.same': 'Two' } }); }, /Duplicate i18n key/);
});

Test('message tokens survive strings, nest, and render per locale', function()
{
  const I18n = fresh();
  I18n.addMessages({
    en: { 'test.tool': 'Tool call: {names}', 'test.unit': { one: '{count} minute ago', other: '{count} minutes ago' }, 'test.wrap': 'Wrapped [{inner}]' },
    ko: { 'test.tool': '도구 호출: {names}', 'test.unit': { other: '{count}분 전' }, 'test.wrap': '감싼 값 [{inner}]' }
  });
  const tool = I18n.token('test.tool', { names: 'Bash, Read & "Edit" ⟦x⟧ 한글' });
  Assert.equal(I18n.resolve(tool, 'en'), 'Tool call: Bash, Read & "Edit" [x] 한글'.replace('[x]', '⟦x⟧'));
  Assert.equal(I18n.resolve('prefix ' + tool + ' suffix', 'ko'), 'prefix 도구 호출: Bash, Read & "Edit" ⟦x⟧ 한글 suffix');
  Assert.equal(I18n.resolve(I18n.token('test.unit', { count: 1 }), 'en'), '1 minute ago');
  Assert.equal(I18n.resolve(I18n.token('test.unit', { count: 5 }), 'en'), '5 minutes ago');
  Assert.equal(I18n.resolve(I18n.token('test.wrap', { inner: I18n.token('test.unit', { count: 3 }) }), 'ko'), '감싼 값 [3분 전]');
  Assert.equal(I18n.resolve('plain text', 'en'), 'plain text');
  Assert.equal(I18n.resolve('broken ⟦test.tool?names=a', 'en'), 'broken ⟦test.tool?names=a', 'an unterminated token is left alone');
  Assert.equal(I18n.resolve('⟦nope.key?a=1⟧', 'en'), '⟦nope.key?a=1⟧', 'a token with an unknown key stays visible');
  Assert.ok(I18n.missingKeys().includes('nope.key'));
  Assert.equal(I18n.resolve(null, 'en'), null);
});

Test('resolveDeep renders tokens in nested data without touching other values', function()
{
  const I18n = fresh();
  I18n.addMessages({ en: { 'test.name': 'Name {id}' }, ko: { 'test.name': '이름 {id}' } });
  const data = { nodes: [{ name: I18n.token('test.name', { id: 7 }), count: 3, flags: [true, null], nested: { text: 'x' } }], title: 'plain' };
  const english = I18n.resolveDeep(data, 'en');
  Assert.deepEqual(english, { nodes: [{ name: 'Name 7', count: 3, flags: [true, null], nested: { text: 'x' } }], title: 'plain' });
  Assert.equal(I18n.resolveDeep(data, 'ko').nodes[0].name, '이름 7');
  Assert.notEqual(english, data);
});

Test('stripMarkers removes token delimiters from observed text', function()
{
  const I18n = fresh();
  Assert.equal(I18n.stripMarkers('a⟦b⟧c'), 'a[b]c');
  Assert.equal(I18n.resolve(I18n.stripMarkers('⟦test.tool?names=x⟧'), 'en'), '[test.tool?names=x]');
});

Test('number and date formatting follow the locale', function()
{
  const I18n = fresh();
  Assert.equal(I18n.formatNumber(1234567, 'en'), '1,234,567');
  Assert.equal(I18n.formatNumber(undefined, 'en'), '0');
  Assert.match(I18n.formatDateTime(new Date(2026, 9, 23, 14, 5, 9), 'en'), /14:05:09/);
  Assert.match(I18n.formatDateTime(new Date(2026, 9, 23, 14, 5, 9), 'ko'), /14시\s*0?5분\s*0?9초/);
});

Test('applyDom renders text, title, aria-label and placeholder bindings', function()
{
  const I18n = fresh();
  I18n.addMessages({ en: { 'test.label': 'Label', 'test.tip': 'Tip' }, ko: { 'test.label': '라벨', 'test.tip': '도움말' } });
  function element(attributes)
  {
    return {
      textContent: '', attributes: Object.assign({}, attributes),
      getAttribute: function(name) { return this.attributes[name]; },
      setAttribute: function(name, value) { this.attributes[name] = value; }
    };
  }
  const text = element({ 'data-i18n': 'test.label' });
  const titled = element({ 'data-i18n-title': 'test.tip', 'data-i18n-aria-label': 'test.label' });
  const html = element({});
  const scope = {
    ownerDocument: { documentElement: html },
    querySelectorAll: function(selector) { return { '[data-i18n]': [text], '[data-i18n-title]': [titled], '[data-i18n-aria-label]': [titled] }[selector] || []; }
  };
  I18n.setLocale('ko');
  I18n.applyDom(scope);
  Assert.equal(text.textContent, '라벨');
  Assert.equal(titled.attributes.title, '도움말');
  Assert.equal(titled.attributes['aria-label'], '라벨');
  Assert.equal(html.attributes.lang, 'ko');
});

Test('every catalog part has matching English and Korean keys, placeholders and plural fallbacks', function()
{
  Helpers.AREAS.forEach(function(area)
  {
    const part = require('../public/locales/' + area + '.js');
    const english = Object.keys(part.en).sort();
    const korean = Object.keys(part.ko).sort();
    Assert.deepEqual(korean, english, 'locales/' + area + '.js: en and ko keys differ');
    english.forEach(function(key)
    {
      Assert.deepEqual(placeholders(part.ko[key]), placeholders(part.en[key]), 'locales/' + area + '.js ' + key + ': placeholders differ');
      [part.en[key], part.ko[key]].forEach(function(message)
      {
        Assert.ok(typeof message === 'string' || (message && typeof message.other === 'string'), 'locales/' + area + '.js ' + key + ': plural messages need an "other" form');
      });
      const englishText = typeof part.en[key] === 'string' ? part.en[key] : Object.keys(part.en[key]).map(function(form) { return part.en[key][form]; }).join(' ');
      Assert.ok(!HANGUL.test(englishText), 'locales/' + area + '.js ' + key + ': English text contains Hangul');
    });
    Assert.ok(english.every(function(key) { return key.indexOf({ html: 'page.', app: 'app.', scene: 'scene.', server: 'msg.', cli: 'cli.' }[area]) === 0; }), 'locales/' + area + '.js: keys must start with the area prefix');
  });
});

Test('all catalog parts register in a browser-like sandbox and in Node without key clashes', function()
{
  const sandbox = Helpers.loadBrowserI18n({}, 'en');
  Assert.equal(sandbox.WasI18n.getLocale(), 'en');
  Assert.doesNotThrow(function() { fresh(); });
});

Test('keys used by the sources exist in both languages', function()
{
  const keys = new Set();
  const catalog = {};
  Helpers.AREAS.forEach(function(area) { Object.assign(catalog, require('../public/locales/' + area + '.js').en); });
  const sources = ['public/index.html', 'public/app.js', 'public/office-scene.js', 'public/office-model.js', 'server.js', 'bin/launcher.js', 'scripts/verify-live.js']
    .concat(listFiles('src', /\.js$/), listFiles('src/sources', /\.js$/).map(function(file) { return file; }));
  sources.forEach(function(file)
  {
    const text = Fs.readFileSync(Path.join(ROOT, file), 'utf8');
    const patterns = [/\b(?:wasT|sceneT)\(\s*(["'])([\w.-]+)\1/g, /\bI18n\.(?:t|token|translate)\(\s*(?:[^,'"]+,\s*)?(["'])([\w.-]+)\1/g, /data-i18n[\w-]*="([\w.-]+)"/g];
    patterns.forEach(function(pattern)
    {
      var match;
      while ((match = pattern.exec(text)) !== null)
      {
        keys.add(match[2] || match[1]);
      }
    });
  });
  keys.forEach(function(key) { Assert.ok(Object.prototype.hasOwnProperty.call(catalog, key), 'missing catalog key: ' + key); });
});

Test('source files contain no hard-coded Korean text', function()
{
  // bin/launch-messages.sh is the shell scripts' own two-language message table, so it is not scanned.
  const files = ['public/index.html', 'public/app.js', 'public/office-scene.js', 'public/office-model.js', 'public/character-model.js', 'server.js', 'bin/launcher.js', 'bin/launch.sh', 'bin/launch-browser.sh', 'bin/stop.sh', 'scripts/verify-live.js', 'schema/supplement.schema.json', 'examples/demo.json']
    .concat(listFiles('src', /\.js$/), listFiles('src/sources', /\.js$/));
  // The language names in the selector are endonyms and must stay in their own script.
  const ENDONYM = '<option value="ko">한국어</option>';
  const offenders = files.filter(function(file) { return HANGUL.test(Fs.readFileSync(Path.join(ROOT, file), 'utf8').split(ENDONYM).join('')); });
  Assert.deepEqual(offenders, [], 'hard-coded Korean remains in: ' + offenders.join(', '));
});
