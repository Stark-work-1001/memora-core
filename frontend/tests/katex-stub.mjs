// markdown.test.mjs 用的 KaTeX 替身：不排版，只记下收到的 TeX 与模式，便于断言"哪些片段被当成了公式"。
export default {
  render(tex, target, options) {
    target.setAttribute('data-tex', tex);
    target.setAttribute('data-display', options && options.displayMode ? '1' : '0');
  },
};
