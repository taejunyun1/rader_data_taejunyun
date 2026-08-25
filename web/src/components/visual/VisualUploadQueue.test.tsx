import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VisualUploadQueue from "./VisualUploadQueue";

function createFile(name: string, type: string) {
  return new File([`${name}-contents`], name, { type });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("VisualUploadQueue", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads multiple image formats as multipart requests with at most two active uploads", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const requests: Array<{ file: File; deferred: ReturnType<typeof deferred<Response>> }> = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((_input, init) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      const file = (body as FormData).get("file");
      expect(file).toBeInstanceOf(File);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const request = { file: file as File, deferred: deferred<Response>() };
      requests.push(request);
      return request.deferred.promise.finally(() => {
        activeRequests -= 1;
      });
    });

    render(<VisualUploadQueue onComplete={onComplete} />);
    const input = screen.getByLabelText("이미지 파일");
    const files = [
      createFile("one.jpg", "image/jpeg"),
      createFile("two.png", "image/png"),
      createFile("three.webp", "image/webp"),
      createFile("four.gif", "image/gif"),
    ];

    await user.upload(input, files);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.file.name)).toEqual(["one.jpg", "two.png"]);
    expect(screen.getByRole("progressbar", { name: "one.jpg 업로드 진행률" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "three.webp 상태" })).toHaveTextContent("대기 중");

    requests[0].deferred.resolve(new Response(null, { status: 201 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(requests[2].file.name).toBe("three.webp");

    requests[1].deferred.resolve(new Response(null, { status: 201 }));
    requests[2].deferred.resolve(new Response(null, { status: 201 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    requests[3].deferred.resolve(new Response(null, { status: 201 }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(maximumActiveRequests).toBe(2);
    expect(screen.getByRole("status", { name: "four.gif 상태" })).toHaveTextContent("완료");
    expect(screen.getByText("4개 업로드 완료")).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("removes pending and error rows while completing after the remaining uploads settle", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const requests: Array<{ deferred: ReturnType<typeof deferred<Response>> }> = [];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() => {
      const request = { deferred: deferred<Response>() };
      requests.push(request);
      return request.deferred.promise;
    });

    render(<VisualUploadQueue onComplete={onComplete} />);
    await user.upload(screen.getByLabelText("이미지 파일"), [
      createFile("error.jpg", "image/jpeg"),
      createFile("keep.png", "image/png"),
      createFile("remove.gif", "image/gif"),
    ]);

    expect(screen.getByRole("button", { name: "remove.gif 업로드 제거" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "remove.gif 업로드 제거" }));
    expect(screen.queryByText("remove.gif")).not.toBeInTheDocument();

    requests[0].deferred.reject(new Error("network unavailable"));
    await waitFor(() => expect(screen.getByRole("status", { name: "error.jpg 상태" })).toHaveTextContent("오류"));
    expect(screen.getByRole("button", { name: "error.jpg 업로드 제거" })).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    requests[1].deferred.resolve(new Response(null, { status: 201 }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(screen.getByRole("status", { name: "keep.png 상태" })).toHaveTextContent("완료");

    await user.click(screen.getByRole("button", { name: "error.jpg 업로드 제거" }));
    expect(screen.queryByText("error.jpg")).not.toBeInTheDocument();
  });
});
