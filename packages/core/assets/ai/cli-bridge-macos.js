/* macOS's built-in JavaScript runtime crosses the file bridge without starting
 * Electron inside an AI sandbox. It has no UI or automation permissions. */
ObjC.import('Foundation');
ObjC.import('stdlib');
function run(argv) {
  var fm = $.NSFileManager.defaultManager, requestPath = null;
  function unwrap(v) { return ObjC.unwrap(v); }
  function print(value, error) {
    var data = $(String(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
    (error ? $.NSFileHandle.fileHandleWithStandardError : $.NSFileHandle.fileHandleWithStandardOutput).writeData(data);
  }
  function read(path, limit) {
    var info = fm.attributesOfItemAtPathError($(path), null);
    if (!info || Number(unwrap(info.objectForKey($.NSFileSize))) > limit) throw Error('ファイルが大きすぎるか、読み取れません');
    var value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    if (!value) throw Error('ファイルを読み取れません');
    return unwrap(value);
  }
  function safe(path, root) {
    var current = path;
    for (;;) {
      var info = fm.attributesOfItemAtPathError($(current), null);
      if (info && unwrap(info.objectForKey($.NSFileType)) === unwrap($.NSFileTypeSymbolicLink)) throw Error('依頼先にシンボリックリンクがあります');
      if (current === root) return;
      current = unwrap($(current).stringByDeletingLastPathComponent);
      if (!current || current === '/') throw Error('依頼先が正しくありません');
    }
  }
  function input() {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    if (Number(data.length) > 1024 * 1024) throw Error('入力が大きすぎます');
    return unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  }
  try {
    var env = $.NSProcessInfo.processInfo.environment;
    var root = unwrap(env.objectForKey('SLIDE_STUDIO_HOME'));
    var opts = {}, pos = [];
    for (var i = 0; i < argv.length; i++) {
      var arg = argv[i];
      if (arg === '--json') { opts.json = true; continue; }
      if (arg === '--root' || arg === '--page' || arg === '--figure' || arg === '--tab') {
        if (++i >= argv.length) throw Error(arg + ' の値がありません');
        opts[arg.slice(2)] = argv[i]; continue;
      }
      if (arg.indexOf('--') === 0) throw Error('未対応のオプション: ' + arg);
      pos.push(arg);
    }
    root = opts.root || root;
    if (!root || root[0] !== '/') throw Error('保管フォルダーを絶対パスで指定してください');
    root = unwrap($(root).stringByStandardizingPath);
    var command = pos[0], body;
    if (command === 'check') body = {operation: 'check', deck: pos[1], page: opts.page, figure: opts.figure};
    else if (command === 'consult') body = {operation: 'consult', tab: opts.tab, question: pos[1] === '-' ? input() : pos[1]};
    else if (command === 'audit' && ['tools', 'run', 'status', 'review'].indexOf(pos[1]) >= 0) {
      body = {operation: 'audit_' + pos[1], deck: pos[2], audit_id: pos[3]};
      if (pos[1] === 'review') body.review = JSON.parse(pos[4] === '-' ? input() : read(pos[4], 1024 * 1024));
    } else throw Error('AI から利用できるコマンドは check・consult・audit です');
    var dir = root + '/.slide-studio/requests'; safe(dir, root);
    if (!fm.fileExistsAtPath($(dir))) throw Error('アプリを開いてから実行してください');
    var id = unwrap($.NSUUID.UUID.UUIDString).replace(/-/g, '').toLowerCase();
    requestPath = dir + '/' + id + '.req.json';
    var responsePath = dir + '/' + id + '.res.json', runPath = dir + '/' + id + '.run';
    var json = JSON.stringify(body);
    if (json.length > 1024 * 1024) throw Error('依頼が大きすぎます');
    if (!$(json).writeToFileAtomicallyEncodingError($(requestPath), true, $.NSUTF8StringEncoding, null)) throw Error('依頼を書き込めません');
    var started = Date.now(), accepted = false;
    while (!fm.fileExistsAtPath($(responsePath))) {
      if (fm.fileExistsAtPath($(runPath))) accepted = true;
      if (Date.now() - started > (accepted ? 900000 : 5000)) throw Error(accepted ? '処理が終わりませんでした' : 'アプリが応答しません');
      $.NSThread.sleepForTimeInterval(0.1);
    }
    safe(responsePath, root);
    var response = JSON.parse(read(responsePath, 16 * 1024 * 1024));
    fm.removeItemAtPathError($(responsePath), null);
    if (command === 'audit') {
      if (!response.result) throw Error(response.summary || '監査に失敗しました');
      print(JSON.stringify(response.result, null, 2)); $.exit(pos[1] === 'tools' || response.result.complete ? 0 : 1);
    }
    print(opts.json ? JSON.stringify(response.result || response, null, 2) : response.answer || response.summary || '');
    $.exit(response.errors ? 1 : 0);
  } catch (error) {
    if (requestPath) fm.removeItemAtPathError($(requestPath), null);
    if (typeof runPath === 'string' && fm.fileExistsAtPath($(runPath))) $('').writeToFileAtomicallyEncodingError($(dir + '/' + id + '.cancel'), true, $.NSUTF8StringEncoding, null);
    print(error.message || String(error), true); $.exit(1);
  }
}
