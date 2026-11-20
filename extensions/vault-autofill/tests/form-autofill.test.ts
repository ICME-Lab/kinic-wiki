import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  extractSubmittedCredentials,
  findLoginTarget,
  isWebOriginFillable
} from "../src/form-detector.ts";
import { fillGeneratedPassword, fillLoginFields } from "../src/form-filler.ts";

describe("Origin eligibility", () => {
  it("allows HTTPS sites and local development origins, and blocks privileged/auth origins", () => {
    expect(isWebOriginFillable("https://github.com/login")).toBe(true);
    expect(isWebOriginFillable("http://localhost:3000/signin")).toBe(true);
    expect(isWebOriginFillable("http://127.0.0.1:8080/login")).toBe(true);

    expect(isWebOriginFillable("http://example.com/login")).toBe(false);
    expect(isWebOriginFillable("chrome://settings")).toBe(false);
    expect(isWebOriginFillable("file:///etc/passwd")).toBe(false);
    expect(isWebOriginFillable("https://id.ai/")).toBe(false);
    expect(isWebOriginFillable("https://vault.kinic.xyz/")).toBe(false);
    expect(
      isWebOriginFillable("https://mcx4q-2qaaa-aaaao-qqn3a-cai.icp0.io/")
    ).toBe(false);
    expect(isWebOriginFillable("https://wiki.kinic.xyz/")).toBe(false);
  });
});

describe("DOM form detection and autofill", () => {
  it("detects and fills a standard login form and dispatches input/change events", () => {
    const dom = new JSDOM(`
      <!doctype html>
      <body>
        <input type="search" name="q" placeholder="Search site" />
        <form id="login">
          <input type="hidden" name="csrf" value="abc" />
          <input id="email" type="email" name="email" autocomplete="username" />
          <input id="pw" type="password" name="password" autocomplete="current-password" />
          <button type="submit">Sign in</button>
        </form>
      </body>
    `);
    const doc = dom.window.document;
    const events: string[] = [];
    const email = doc.getElementById("email") as HTMLInputElement;
    const pw = doc.getElementById("pw") as HTMLInputElement;
    email.addEventListener("input", () => events.push("email:input"));
    email.addEventListener("change", () => events.push("email:change"));
    pw.addEventListener("input", () => events.push("pw:input"));
    pw.addEventListener("change", () => events.push("pw:change"));

    const result = fillLoginFields(doc, {
      username: "alice@example.com",
      password: "super-secret-password"
    });

    expect(result).toEqual({
      filledUsername: true,
      filledPassword: true,
      filledTotp: false
    });
    expect(email.value).toBe("alice@example.com");
    expect(pw.value).toBe("super-secret-password");
    expect(events).toEqual([
      "email:input",
      "email:change",
      "pw:input",
      "pw:change"
    ]);
  });

  it("handles SPA login views without a <form> element and fills 2FA inputs", () => {
    const dom = new JSDOM(`
      <!doctype html>
      <body>
        <div class="auth-panel">
          <input id="u" type="text" placeholder="Username or email" />
          <input id="p" type="password" />
          <input id="code" type="text" autocomplete="one-time-code" />
        </div>
      </body>
    `);
    const doc = dom.window.document;

    const result = fillLoginFields(doc, {
      username: "alice",
      password: "pw-value",
      totp: "123456"
    });

    expect(result).toEqual({
      filledUsername: true,
      filledPassword: true,
      filledTotp: true
    });
    expect((doc.getElementById("u") as HTMLInputElement).value).toBe("alice");
    expect((doc.getElementById("p") as HTMLInputElement).value).toBe("pw-value");
    expect((doc.getElementById("code") as HTMLInputElement).value).toBe("123456");
  });

  it("fills new-password and confirm-password on password change forms without touching current-password", () => {
    const dom = new JSDOM(`
      <!doctype html>
      <body>
        <form>
          <input id="cur" type="password" autocomplete="current-password" value="old-pw" />
          <input id="new1" type="password" autocomplete="new-password" />
          <input id="new2" type="password" autocomplete="new-password" />
        </form>
      </body>
    `);
    const doc = dom.window.document;
    const res = fillGeneratedPassword(doc, "Generated-Strong-99!");

    expect(res.filledCount).toBe(2);
    expect((doc.getElementById("cur") as HTMLInputElement).value).toBe("old-pw");
    expect((doc.getElementById("new1") as HTMLInputElement).value).toBe(
      "Generated-Strong-99!"
    );
    expect((doc.getElementById("new2") as HTMLInputElement).value).toBe(
      "Generated-Strong-99!"
    );
  });

  it("ignores hidden or disabled inputs when detecting login forms", () => {
    const dom = new JSDOM(`
      <!doctype html>
      <body>
        <form>
          <input id="hidden-u" type="email" style="display: none" />
          <input id="disabled-p" type="password" disabled />
        </form>
      </body>
    `);
    const target = findLoginTarget(dom.window.document);
    expect(target).toBeNull();
  });

  it("extracts submitted credentials and ignores empty passwords", () => {
    const dom = new JSDOM(`
      <!doctype html>
      <body>
        <form id="f">
          <input id="u" type="email" value="bob@example.com" />
          <input id="p" type="password" value="" />
        </form>
      </body>
    `);
    const form = dom.window.document.getElementById("f") as HTMLFormElement;
    const p = dom.window.document.getElementById("p") as HTMLInputElement;

    expect(extractSubmittedCredentials(form)).toBeNull();

    p.value = "my-pass-123";
    expect(extractSubmittedCredentials(form)).toEqual({
      username: "bob@example.com",
      password: "my-pass-123"
    });
  });
});
