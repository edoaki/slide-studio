"""箇条書き・画像の段階表示を、プレイヤー共通の data-step に展開する。"""

def expand_incremental(root):
    for wrapper in root.select('.incremental'):
        if wrapper.find_parent(class_='incremental') is not None:
            continue
        try:
            start = max(0, int(wrapper.get('data-step', '1')))
        except ValueError:
            start = 1
        items = [li for li in wrapper.select('li')
                 if not any(p.name == 'li' for p in li.parents if p is not wrapper and wrapper in p.parents)]
        for offset, li in enumerate(items):
            li['data-step'] = str(start + offset)
            li['data-slide-studio-step-generated'] = 'true'


def lift_image_steps(root):
    """画像だけの段落・図（説明つき）では、data-step を外側に移して説明も一緒に隠す。"""
    for img in root.select('img[data-step]'):
        box = img.parent
        if box is None or box.name not in ('figure', 'p'):
            continue
        if box.name == 'p' and any(c is not img and (getattr(c, 'name', None) or str(c).strip()) for c in box.children):
            continue
        box['data-step'] = img['data-step']
        del img['data-step']
