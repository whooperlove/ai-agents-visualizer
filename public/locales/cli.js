(function (root, factory)
{
  var parts = factory();
  if (typeof module === "object" && module.exports)
  {
    module.exports = parts;
  }
  else if (root.WasI18n)
  {
    root.WasI18n.addMessages(parts);
  }
})(typeof self !== "undefined" ? self : this, function ()
{
  "use strict";

  return {
    en: {
      "cli.server.optionUnknown": "Unknown option or missing value: {option}",
      "cli.server.portInvalid": "port must be an integer from 0 to 65535.",
      "cli.server.pollMsInvalid": "poll-ms must be an integer of 250 or more.",
      "cli.server.langInvalid": "--lang must be en or ko: {value}",
      "cli.server.usage": "node server.js [--port 4317] [--supplement /absolute/path.json] [--no-supplement] [--home /home/to/observe] [--poll-ms 2500] [--lang en|ko]",
      "cli.server.startFailed": "Server failed to start: {code}",
      "cli.server.listening": "AI Agents Visualizer (read-only): {url}",
      "cli.http.hostNotAllowed": "Host not allowed",
      "cli.http.originNotAllowed": "Origin not allowed",
      "cli.http.notFound": "Not found",
      "cli.http.notReady": "Preparing the page",
      "cli.launcher.responseAborted": "The server response was interrupted.",
      "cli.launcher.probeTimeout": "The local server did not respond in time.",
      "cli.launcher.portInvalid": "The server port must be an integer from 1 to 65535.",
      "cli.launcher.serverMissing": "Could not find server.js to run: {path}",
      "cli.launcher.startTimeout": {
        one: "The server was not ready within {count} second. Log: {path}",
        other: "The server was not ready within {count} seconds. Log: {path}"
      },
      "cli.launcher.exitedEarly": "The server exited before it was ready ({status}). Log: {path}",
      "cli.launcher.portBusy": "Port {port} is in use by another service or an earlier visualizer. The existing process was left unchanged.",
      "cli.launcher.nodeRequired": "Node.js 22 or later is required.",
      "cli.launcher.started": "Started the read-only visualizer server.",
      "cli.launcher.reused": "Using the running visualizer server.",
      "cli.verifyLiveReadError": "Error reading verification data"
    },
    ko: {
      "cli.server.optionUnknown": "알 수 없거나 값이 없는 옵션: {option}",
      "cli.server.portInvalid": "port는 0~65535 정수여야 합니다.",
      "cli.server.pollMsInvalid": "poll-ms는 250 이상의 정수여야 합니다.",
      "cli.server.langInvalid": "--lang은 en 또는 ko여야 합니다: {value}",
      "cli.server.usage": "node server.js [--port 4317] [--supplement /절대/경로.json] [--no-supplement] [--home /관찰할/home] [--poll-ms 2500] [--lang en|ko]",
      "cli.server.startFailed": "서버 시작 실패: {code}",
      "cli.server.listening": "AI Agents Visualizer (읽기 전용): {url}",
      "cli.http.hostNotAllowed": "허용하지 않는 호스트",
      "cli.http.originNotAllowed": "허용하지 않는 출처",
      "cli.http.notFound": "찾을 수 없음",
      "cli.http.notReady": "화면 준비 중",
      "cli.launcher.responseAborted": "서버 응답이 중단되었습니다.",
      "cli.launcher.probeTimeout": "로컬 서버 응답 시간이 초과되었습니다.",
      "cli.launcher.portInvalid": "서버 포트는 1~65535 정수여야 합니다.",
      "cli.launcher.serverMissing": "실행할 server.js를 찾지 못했습니다: {path}",
      "cli.launcher.startTimeout": "{count}초 안에 서버가 준비되지 않았습니다. 로그: {path}",
      "cli.launcher.exitedEarly": "서버가 준비 전에 종료되었습니다 ({status}). 로그: {path}",
      "cli.launcher.portBusy": "{port} 포트가 다른 서비스 또는 이전 visualizer에 사용 중입니다. 기존 프로세스는 변경하지 않았습니다.",
      "cli.launcher.nodeRequired": "Node.js 22 이상이 필요합니다.",
      "cli.launcher.started": "읽기 전용 visualizer 서버를 시작했습니다.",
      "cli.launcher.reused": "실행 중인 visualizer 서버를 사용합니다.",
      "cli.verifyLiveReadError": "검증 자료 읽기 오류"
    }
  };
});
