-- Slide Studio の Pandoc フィルター（設計書 §7.1）
--   {{< fig 棚/名前 >}} と {{< fig ./名前 >}} だけの段落を、図の iframe にする。
-- 図の場所は描画する発表のフォルダからの相対パスで書く（プレビュー・検査・書き出しで同じ）。

-- 空行のない改行は、同じブロック内の改行として表示する。
function SoftBreak()
  return pandoc.LineBreak()
end

local function inline_text(inlines)
  local out = {}
  for _, el in ipairs(inlines) do
    if el.t == 'Str' then
      table.insert(out, el.text)
    elseif el.t == 'Space' or el.t == 'SoftBreak' then
      table.insert(out, ' ')
    elseif el.t == 'Quoted' then
      local q = el.quotetype == 'SingleQuote' and "'" or '"'
      table.insert(out, q .. inline_text(el.content) .. q)
    else
      table.insert(out, pandoc.utils.stringify(el))
    end
  end
  return table.concat(out)
end

local function escape(s)
  return (s:gsub('&', '&amp;'):gsub('"', '&quot;'):gsub('<', '&lt;'):gsub('>', '&gt;'))
end

local function parse_args(rest)
  local args, ref = {}, nil
  local i = 1
  while i <= #rest do
    local _, e, key, value = rest:find('^%s*([%w%-]+)="([^"]*)"', i)
    if not e then _, e, key, value = rest:find("^%s*([%w%-]+)='([^']*)'", i) end
    if not e then _, e, key, value = rest:find('^%s*([%w%-]+)=(%S+)', i) end
    if e then
      args[key] = value
      i = e + 1
    else
      local _, e2, word = rest:find('^%s*(%S+)', i)
      if not e2 then break end
      if not ref then ref = word end
      i = e2 + 1
    end
  end
  return ref, args
end

local function px(v)
  if not v then return nil end
  if v:match('^%d+%.?%d*$') then return v .. 'px' end
  return v
end

function Para(el)
  local text = inline_text(el.content)
  local rest = text:match('^{{<%s*fig%s+(.-)%s*>}}$')
  if not rest then return nil end
  local ref, args = parse_args(rest)
  if not ref then return nil end
  ref = ref:gsub('^"', ''):gsub('"$', '')
  local topic, name = ref:match('^([^/]+)/(.+)$')
  if not topic or topic == '.' then return nil end
  local src = '../../topics/' .. topic .. '/html/' .. name .. '/index.html'
  local style = {}
  if args.width then table.insert(style, 'width:' .. px(args.width)) end
  if args.height then table.insert(style, 'height:' .. px(args.height)) end
  -- pad="8 0"：その図だけの内側の余白（数だけなら px）
  if args.pad then
    local parts = {}
    for v in args.pad:gmatch('%S+') do table.insert(parts, px(v)) end
    table.insert(style, 'padding:' .. table.concat(parts, ' '))
  end
  -- 外側余白は専用引数。style 内の -- は Markdown の smart で長いダッシュに変わるため。
  if args.space then
    local parts = {}
    for v in args.space:gmatch('%S+') do table.insert(parts, px(v)) end
    table.insert(style, '--block-space:' .. table.concat(parts, ' '))
  end
  if args.style then table.insert(style, escape(args.style)) end
  local style_attr = #style > 0 and (' style="' .. table.concat(style, ';') .. '"') or ''
  local title = args.title and (' title="' .. escape(args.title) .. '"') or ''
  -- step="1"：段階表示の段（本文の data-step と同じ数え方）
  local step_attr = args.step and args.step:match('^%d+$') and (' data-step="' .. args.step .. '"') or ''
  local html = '<div class="animation loaded" data-slide-studio-fig="' .. escape(ref) .. '"' .. step_attr .. style_attr .. '>'
    .. '<iframe src="' .. escape(src) .. '"' .. title .. ' tabindex="-1"></iframe></div>'
  return pandoc.RawBlock('html', html)
end

-- 長い pipe table は区切り線が同じ長さでも均等幅の colgroup が付く。
-- 均等な指定は内容に合わせ、異なる比率が書かれた列幅は保持する。
function Table(el)
  if #el.colspecs < 2 then return nil end
  local width = el.colspecs[1][2]
  if not width or width == 0 then return nil end
  for _, spec in ipairs(el.colspecs) do
    if spec[2] ~= width then return nil end
  end
  local specs = {}
  for _, spec in ipairs(el.colspecs) do
    table.insert(specs, {spec[1]})
  end
  el.colspecs = specs
  return el
end

-- 表の文字サイズ・太さ・列の幅は、表を囲む ::: {style="--table-size:24px;--table-weight:700;--table-cols:200 400 400"} に書く。
-- テーマや発表の CSS より強く効くよう、表とセルの style に直接書く。列の幅を決めた表は必ず折り返して下に伸びる。
local function style_value(style, name)
  for part in style:gmatch('[^;]+') do
    local key, value = part:match('^%s*([%w-]+)%s*:%s*(.-)%s*$')
    if key == name then return value end
  end
end

local function add_style(el, value)
  local old = el.attributes.style
  el.attributes.style = old and (old .. ';' .. value) or value
end

local function each_cell(t, fn)
  for _, row in ipairs(t.head.rows) do for _, cell in ipairs(row.cells) do fn(cell) end end
  for _, body in ipairs(t.bodies) do
    for _, row in ipairs(body.head) do for _, cell in ipairs(row.cells) do fn(cell) end end
    for _, row in ipairs(body.body) do for _, cell in ipairs(row.cells) do fn(cell) end end
  end
end

local function first_row(t)
  if #t.head.rows > 0 then return t.head.rows[1] end
  return t.bodies[1] and (t.bodies[1].head[1] or t.bodies[1].body[1])
end

local function apply_table_style(t, style)
  -- Div は内側から処理される。表に近い包みで設定済みの値は外側で上書きしない。
  local current = t.attributes.style or ''
  local size = style_value(style, '--table-size')
  if size and size:match('^%d+%.?%d*px$') and not style_value(current, 'font-size') then add_style(t, 'font-size:' .. size) end
  local weight = style_value(style, '--table-weight')
  if weight and weight:match('^[1-9]00$') then
    each_cell(t, function(cell)
      if not style_value(cell.attributes.style or '', 'font-weight') then add_style(cell, 'font-weight:' .. weight) end
    end)
  end
  local cols = {}
  local total = 0
  for v in (style_value(style, '--table-cols') or ''):gmatch('%S+') do
    if not v:match('^%d+$') then cols = {} total = 0 break end
    table.insert(cols, v)
    total = total + tonumber(v)
  end
  local first = first_row(t)
  if total > 0 and first and #cols == #t.colspecs and #cols == #first.cells and not style_value(current, 'width') then
    local specs = {}
    for i, spec in ipairs(t.colspecs) do
      specs[i] = {spec[1]}
      add_style(first.cells[i], 'width:' .. cols[i] .. 'px')
    end
    t.colspecs = specs
    add_style(t, 'width:' .. total .. 'px;table-layout:fixed;overflow-wrap:anywhere')
    each_cell(t, function(cell) add_style(cell, 'white-space:normal') end)
  end
  return t
end

function Div(el)
  -- HTML writer は column の width を別の style 属性として追加する。
  -- 既存の余白などと合わせてから width 属性を除き、重複と幅の欠落を防ぐ。
  local width = el.attributes.width
  if width and el.classes:includes('column') then
    if not style_value(el.attributes.style or '', 'width') then
      add_style(el, 'width:' .. width)
    end
    el.attributes.width = nil
  end
  local style = el.attributes.style
  if not style or not style:find('--table-', 1, true) then return el end
  return el:walk({ Table = function(t) return apply_table_style(t, style) end })
end
