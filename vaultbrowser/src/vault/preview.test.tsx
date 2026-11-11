import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { VaultPreview } from "./preview";
it("renders private Markdown without resource loads, navigation, raw HTML or Wiki actions", () => {
  const html = renderToStaticMarkup(
    <VaultPreview
      content={
        '# Private\n![photo](https://example.test/leak)\n[link](https://example.test/leak)\n[[Wiki/node]]\n<script>secret</script>\n<iframe src="https://example.test/leak"></iframe>'
      }
    />,
  );
  expect(html).toContain("Private");
  expect(html).not.toMatch(/<img|<a[ >]|<iframe|<script|src=|href=/);
  expect(html).toContain("[Image: photo]");
});
