/**
 * Central Japanese UI copy. Every user-visible label, state and error message
 * used by the desktop shell belongs here. Server-provided deck titles and
 * diagnostics are user content and are rendered as text, not treated as copy.
 */
export const strings = {
  appName: 'Slide Studio',
  appSubtitle: 'QMD 原稿を直接編集',
  documentTitle: 'Slide Studio',
  brandMark: 'SS',

  workspace: {
    label: '保管フォルダ',
    sidebarLabel: 'ワークスペース',
    loading: '保管フォルダを読み込み中…',
    none: '未選択',
    select: 'フォルダを選択',
    selecting: '選択中…',
    cancelled: 'フォルダの選択をキャンセルしました。'
  },

  deck: {
    label: 'スライド',
    count: '{count} 件',
    loading: 'スライド一覧を読み込み中…',
    empty: 'スライドはまだありません。',
    untitled: '無題のスライド',
    newTitle: '新しいスライド名',
    create: '作成',
    creating: '作成中…'
  },

  editor: {
    label: 'QMD 原稿',
    noDeckTitle: 'スライド未選択',
    placeholder: 'ここに QMD 原稿を入力します。',
    placeholderEmpty: 'スライドを作成するか、一覧から選択してください。',
    readOnly: 'この原稿は読み取り専用です。',
    loading: 'スライドを読み込み中…',
    unsaved: '未保存の変更があります。'
  },

  preview: {
    label: 'プレビュー',
    loading: 'プレビューを更新しています…',
    ready: 'プレビュー更新済み',
    readyWithWarnings: 'プレビュー更新済み（警告 {count} 件）',
    error: 'プレビュー更新エラー',
    empty: 'プレビューを表示するにはスライドを選択してください。',
    emptyNoDeck: 'スライドがありません。新しく作成してください。',
    previous: '前へ',
    next: '次へ',
    slideSelectLabel: '表示するページ',
    pageOf: '{current} / {total}',
    noPages: '—',
    diagnosticsHead: '警告・診断',
    diagnosticsCount: '{count} 件',
    warning: '警告',
    errorSeverity: 'エラー',
    warningItem: '{severity}: {message}',
    warningItemLine: '{severity}（行 {line}）: {message}',
    slideOption: '{number}. {title}',
    untitledSlide: '無題のページ',
    frameTitle: 'スライドプレビュー'
  },

  save: {
    button: '保存',
    none: '—',
    saving: '保存中…',
    saved: '保存済み',
    unsaved: '未保存',
    conflict: '保存の競合',
    conflictDetail: '外部で原稿が変更されています。原稿は上書きしていません。',
    readOnly: '読み取り専用',
    error: '保存エラー'
  },

  export: {
    groupLabel: '書き出し',
    html: 'HTML 書き出し',
    pdf: 'PDF 書き出し（試験的）',
    busy: '書き出し中…',
    saved: '書き出し先: {file}',
    cancelled: '書き出しをキャンセルしました。',
    error: '書き出しに失敗しました。'
  },

  confirm: {
    switchDeck: '未保存の変更があります。破棄して別のスライドに切り替えますか？',
    createDeck: '未保存の変更があります。破棄して新しいスライドを作成しますか？',
    switchWorkspace: '未保存の変更があります。破棄して保管フォルダを切り替えますか？'
  },

  notices: {
    trial: '原稿（QMD）の直接編集を試す試験版です。',
    unavailable: '直接編集・AI・履歴はまだ利用できません。',
    pdf: 'PDF 書き出しは試験的です。'
  },

  errors: {
    MISSING_TOKEN: '起動用トークンが見つかりません。アプリを起動し直してください。',
    NETWORK: 'サーバーに接続できませんでした。',
    INVALID_RESPONSE: 'サーバーから予期しない応答が返されました。',
    NOT_FOUND: '対象が見つかりません。',
    CONFLICT: '保存の競合が発生しました。',
    OUTSIDE_ROOT: '保管フォルダの外は操作できません。',
    LOCKED: '保管フォルダは使用中です。',
    INVALID_INPUT: '入力内容を確認してください。',
    READ_ONLY: 'この原稿は読み取り専用です。',
    RENDER_TIMEOUT: 'プレビューの生成がタイムアウトしました。',
    RENDER_FAILED: 'プレビューの生成に失敗しました。',
    BUSY: '処理中です。しばらく待ってから再試行してください。',
    TITLE_REQUIRED: 'スライド名を入力してください。',
    INVALID_PREVIEW_URL: 'プレビューの配信元が安全でないため表示を中止しました。',
    workspaceLoad: '保管フォルダを読み込めませんでした。',
    deckLoad: 'スライドを読み込めませんでした。',
    deckCreate: 'スライドを作成できませんでした。',
    workspaceSelect: '保管フォルダを選択できませんでした。',
    save: '保存できませんでした。',
    preview: 'プレビューを更新できませんでした。',
    export: '書き出しに失敗しました。',
    generic: '処理に失敗しました。',
    retry: '再試行'
  }
};

export default strings;
