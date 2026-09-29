import { expect, test } from "bun:test";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_INLINE_PREVIEW_MAX_BYTES } from "../../../shared/filePreview";
import { publishConnectionHttpResponse } from "../connections/http-routing";
import { shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";
import { fileDownloadRange } from "./file-download";
import { runBinaryProcessWithTimeout } from "./process";

test("audio range parsing handles boundaries and ignores unsupported ranges", () => {
  for (const [range, expected] of [
    ["bytes=0-1", { start: 0, end: 1 }],
    ["bytes=8-", { start: 8, end: 9 }],
    ["bytes=-2", { start: 8, end: 9 }],
    ["bytes=-99999999999999999999999", { start: 0, end: 9 }],
    ["bytes=1-99999999999999999999999", { start: 1, end: 9 }],
    ["bytes=0-1,4-5", undefined],
    ["bytes=x-y", undefined],
    ["items=0-1", undefined],
  ] as const) {
    expect(fileDownloadRange("clip.wav", 10, { range })).toEqual(expected);
  }
  for (const range of [
    "bytes=10-",
    "bytes=99999999999999999999999-",
    "bytes=2-1",
    "bytes=-0",
  ]) {
    expect(() => fileDownloadRange("clip.wav", 10, { range })).toThrow(
      "not satisfiable",
    );
  }
  expect(() =>
    fileDownloadRange("empty.wav", 0, { range: "bytes=0-0" }),
  ).toThrow("not satisfiable");
  expect(
    fileDownloadRange("clip.wav", AUDIO_INLINE_PREVIEW_MAX_BYTES, {
      inline: true,
      range: "bytes=0-1",
    }),
  ).toEqual({ start: 0, end: 1 });
  expect(() =>
    fileDownloadRange("clip.WAV", AUDIO_INLINE_PREVIEW_MAX_BYTES + 1, {
      inline: true,
    }),
  ).toThrow("too large");
});

// Exercise actual HTTP serialization and the production lease wrapper, not just
// Response.headers. Execute the exact SSH shell command locally for parity.
test.each([false, true])(
  "audio HTTP ranges and size limits (SSH: %s)",
  async (remote) => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-audio-'"));
    const bytes = Buffer.from(
      Array.from({ length: 150000 }, (_, i) => i % 251),
    );
    const remoteOutputs: number[] = [];
    await writeFile(join(root, "clip.WAV"), bytes);
    const large = await open(join(root, "large.wav"), "w");
    await large.truncate(AUDIO_INLINE_PREVIEW_MAX_BYTES + 1);
    await large.close();
    await symlink(join(root, "large.wav"), join(root, "alias.txt"));
    let current = true;
    let changeBeforeRead = false;
    const handlers = createFileHandlers({
      herdr: {
        call: async () => ({
          workspace: { worktree: { checkout_path: root } },
        }),
      } as any,
      sshHost: () => (remote ? "example.invalid" : undefined),
      shQuote,
      runProcessWithCodeTimeout: async (argv, timeout) => {
        if (changeBeforeRead && argv[argv.length - 1]!.includes("dd if=")) {
          changeBeforeRead = false;
          await writeFile(join(root, "changing.wav"), "changed");
        }
        const result = await runBinaryProcessWithTimeout(
          ["bash", "-c", argv[argv.length - 1]!],
          timeout,
        );
        remoteOutputs.push(result.stdout.length);
        return { ...result, stdout: result.stdout.toString("utf8") };
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const response = await handlers.downloadWorkspaceFile({
          workspace_id: "w1",
          path: url.searchParams.get("path") ?? "clip.WAV",
          scope: url.searchParams.get("scope"),
          inline: url.searchParams.get("inline") !== "0",
          range: request.headers.get("range") ?? undefined,
          if_range: request.headers.get("if-range") ?? undefined,
        });
        return publishConnectionHttpResponse(
          {
            connectionId: "audio-test",
            generation: 1,
            isCurrent: () => current,
          },
          response,
        );
      },
    });
    try {
      const response = await fetch(server.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      // Bun uses chunked framing for guarded streams. Partial responses must
      // retain Content-Range so browsers still know the total and can seek.
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

      for (const [range, start, end] of [
        ["bytes=0-1", 0, 2],
        ["bytes=65535-65537", 65535, 65538],
        ["bytes=149997-", 149997, 150000],
        ["bytes=-3", 149997, 150000],
        ["bytes=149997-999999", 149997, 150000],
      ] as const) {
        remoteOutputs.length = 0;
        const partial = await fetch(server.url, { headers: { Range: range } });
        expect(partial.status).toBe(206);
        expect(partial.headers.get("content-range")).toBe(
          `bytes ${start}-${end - 1}/${bytes.length}`,
        );
        const length = partial.headers.get("content-length");
        if (length !== null) expect(length).toBe(String(end - start));
        expect(partial.headers.get("x-content-type-options")).toBe("nosniff");
        expect(partial.headers.get("x-herdr-connection-id")).toBe("audio-test");
        expect(Buffer.from(await partial.arrayBuffer())).toEqual(
          bytes.subarray(start, end),
        );
        if (remote)
          expect(
            remoteOutputs.reduce((sum, length) => sum + length, 0),
          ).toBeLessThan((bytes.length * 4) / 3);
      }

      const staleRange = await fetch(server.url, {
        headers: { Range: "bytes=1-", "If-Range": '"stale"' },
      });
      expect(staleRange.status).toBe(200);
      expect(staleRange.headers.has("content-range")).toBe(false);
      expect(Buffer.from(await staleRange.arrayBuffer())).toEqual(bytes);

      const outside = await fetch(server.url, {
        headers: { Range: "bytes=150000-" },
      });
      expect(outside.status).toBe(416);
      expect(outside.headers.get("content-range")).toBe("bytes */150000");
      await outside.arrayBuffer();

      const absolute = new URL(server.url);
      absolute.searchParams.set("path", join(root, "clip.WAV"));
      absolute.searchParams.set("scope", "filesystem");
      const external = await fetch(absolute, {
        headers: { Range: "bytes=0-1" },
      });
      expect(external.status).toBe(206);
      expect(Buffer.from(await external.arrayBuffer())).toEqual(
        bytes.subarray(0, 2),
      );

      for (const path of ["large.wav", "alias.txt"]) {
        remoteOutputs.length = 0;
        const tooLarge = await fetch(new URL(`?path=${path}`, server.url), {
          headers: { Range: "bytes=0-1" },
        });
        expect(tooLarge.status).toBe(413);
        expect(await tooLarge.text()).toContain("Use Download");
        if (remote) expect(remoteOutputs).toEqual([0]);
      }
      const download = await fetch(
        new URL("?path=large.wav&inline=0", server.url),
        { headers: { Range: "bytes=0-1" } },
      );
      expect(download.status).toBe(206);
      expect(download.headers.get("content-disposition")).toStartWith(
        "attachment;",
      );
      expect((await download.arrayBuffer()).byteLength).toBe(2);

      if (remote) {
        await writeFile(join(root, "changing.wav"), "old");
        changeBeforeRead = true;
        await expect(
          handlers.downloadWorkspaceFile({
            workspace_id: "w1",
            path: "changing.wav",
            inline: true,
            range: "bytes=0-1",
          }),
        ).rejects.toThrow("file changed during download");
      }

      current = false;
      const retired = await fetch(server.url, {
        headers: { Range: "bytes=0-1" },
      });
      expect(retired.status).toBe(409);
      await retired.arrayBuffer();
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
