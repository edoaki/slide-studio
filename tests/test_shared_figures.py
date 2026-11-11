from slide_studio.ai.chat import Chat
from slide_studio.server import StudioServer
from slide_studio import figures
from slide_studio.fsutil import write_atomic


def test_prompt_and_target_users_share_the_original(ws):
    for deck in ('talk', 'other'):
        ws.new_deck(deck, 'test')
        write_atomic(ws.qmd(deck), ws.qmd(deck).read_text() + '\n## 図\n\n{{< fig test/chart >}}\n')
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    chat = Chat(StudioServer(ws))
    prompt = chat.prompt('talk', [{'key':'fig:test/chart', 'label':'chart', 'text':'色を直す'}])
    assert '[必須] トピックの図はそのまま直す' in prompt
    assert '使っている発表：other、talk' in prompt
    assert 'topics/test/html/chart/figure.mjs' in prompt
    assert 'fig fork' not in prompt and 'fig promote' not in prompt
    assert chat.public('talk')['figure_users']['test/chart'] == ['other', 'talk']


def test_copy_deck_to_other_topic_preserves_images_and_figures(ws):
    ws.new_deck('talk', 'test')
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    write_atomic(ws.images_dir('talk') / 'plot.png', b'original')
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text() + '\n![](images/plot.png)\n\n{{< fig test/chart >}}\n')
    write_atomic(ws.topic_dir('other') / 'images/plot.png', b'existing')
    ws.new_deck('copy', 'other', source_deck='talk')
    assert 'fig other/chart' in ws.qmd('copy').read_text()
    assert 'images/plot-2.png' in ws.qmd('copy').read_text()
    assert (ws.images_dir('copy') / 'plot.png').read_bytes() == b'existing'
    assert (ws.images_dir('copy') / 'plot-2.png').read_bytes() == b'original'
