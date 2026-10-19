-- pandoc Lua filter run on every conversion: fixes what pandoc's writers leave to the caller.

-- Typst: Noto Sans CJK SC (the image's one CJK family) after the body font, so mixed English and Chinese typesets;
-- a document's own `mainfont` still wins. A table longer than the rest of the page breaks across pages instead of
-- jumping whole to the next one. `landscape` (set by the server) flips the page. All go in with the document's own
-- header-includes rather than over them.
function Meta(meta)
  if FORMAT ~= 'typst' then return end
  local header = meta['header-includes']
  header = header == nil and pandoc.List{} or pandoc.utils.type(header) == 'List' and header or pandoc.List{header}
  header:insert(1, pandoc.RawBlock('typst', '#set text(font: ("Libertinus Serif", "Noto Sans CJK SC"))\n#show figure.where(kind: table): set block(breakable: true)'))
  if meta.landscape then header:insert(pandoc.RawBlock('typst', '#set page(flipped: true)')) end
  meta.landscape = nil
  meta['header-includes'] = header
  return meta
end

-- Typst: a table cell is written as `[...]` markup without pandoc's line-start escaping, so a cell reading "- x",
-- "+ 2", "1. x", "= x" or "/ x" became a list, heading or term. Escape the marker.
local function escape(blocks)
  for _, block in ipairs(blocks) do
    local first, second = block.content and block.content[1], block.content and block.content[2]
    if first and first.t == 'Str' and (second == nil or second.t == 'Space' or second.t == 'SoftBreak') then
      local marker = first.text:match('^[-+=/]$') and '\\' .. first.text or first.text:match('^%d+%.$') and first.text:sub(1, -2) .. '\\.'
      if marker then block.content[1] = pandoc.RawInline('typst', marker) end
    end
  end
end

function Table(tbl)
  if FORMAT ~= 'typst' then return end
  local function rows(list) for _, row in ipairs(list) do for _, cell in ipairs(row.cells) do escape(cell.contents) end end end
  rows(tbl.head.rows)
  for _, body in ipairs(tbl.bodies) do rows(body.head); rows(body.body) end
  rows(tbl.foot.rows)
  return tbl
end

-- Office formats: the image's source doubles as its description, so a data URI (a logo) became the whole base64
-- string there. Store it under a short content-hash name instead.
function Image(img)
  if not (FORMAT:match('docx') or FORMAT:match('pptx') or FORMAT:match('odt')) or not img.src:match('^data:') then return end
  local mime, bytes = pandoc.mediabag.fetch(img.src)
  local name = pandoc.utils.sha1(bytes) .. '.' .. (mime:match('^image/(%w+)') or 'bin')
  pandoc.mediabag.insert(name, mime, bytes)
  img.src = name
  return img
end
