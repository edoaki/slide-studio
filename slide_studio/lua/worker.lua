-- 1行JSONの要求/応答。標準入力を閉じると終了する（HTTPポートは開かない）。
assert(pandoc.log.silence and pandoc.utils.run_lua_filter)
io.stdout:setvbuf('no')
io.write('{"ready":true}\n')

local function convert(req)
  local opts = pandoc.cli.parse_options(req.args)
  return pandoc.system.with_working_directory(req.cwd, function()
    local doc = pandoc.read(req.text, opts.from)
    -- このアプリが渡す CLI メタデータは文字列と真偽値のみ。
    for key, value in pairs(opts.metadata) do
      if value.t == 'MetaString' then doc.meta[key] = pandoc.MetaString(value.c)
      elseif value.t == 'MetaBool' then doc.meta[key] = pandoc.MetaBool(value.c)
      else error('Unsupported metadata: ' .. key) end
    end
    for _, filter in ipairs(opts.filters) do
      if filter.type == 'lua' then
        local env = {}
        for key, value in pairs(_G) do env[key] = value end
        env.FORMAT = opts.to
        doc = pandoc.utils.run_lua_filter(doc, filter.path, env)
      elseif filter.type == 'citeproc' then
        doc = pandoc.utils.citeproc(doc)
      else error('Unsupported filter: ' .. filter.type) end
    end
    local writer = pandoc.WriterOptions{
      wrap_text = 'none', html_math_method = opts['html-math-method'],
    }
    return pandoc.write(doc, opts.to, writer)
  end)
end

for line in io.lines() do
  local ok, result = pcall(function()
    local req = pandoc.json.decode(line)
    local logs, output = pandoc.log.silence(function() return convert(req) end)
    local warnings = {}
    for _, log in ipairs(logs) do
      local entry = pandoc.json.decode(pandoc.json.encode(log))
      if entry.verbosity == 'WARNING' or entry.verbosity == 'ERROR' then
        warnings[#warnings + 1] = '[' .. entry.verbosity .. '] ' .. entry.pretty .. '\n'
      end
    end
    if output ~= '' and output:sub(-1) ~= '\n' then output = output .. '\n' end
    return {ok = true, output = output, stderr = table.concat(warnings)}
  end)
  if not ok then result = {ok = false, error = tostring(result)} end
  io.write(pandoc.json.encode(result), '\n')
  -- 別の資料にメディアと変換状態を持ち越さない。
  pandoc.mediabag.empty()
  collectgarbage('step')
end
