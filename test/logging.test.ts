import { describe, expect, it, vi } from "vitest";
import { OperationLogger } from "../src/logging.js";

describe("OperationLogger", () => {
  it("prints client rejection details with Chinese labels", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new OperationLogger(".", "logging-test", false);

    logger.event({
      action: "client.rejected",
      status: "denied",
      clientIp: "203.0.113.11",
      clientId: "11111111-1111-4111-8111-111111111111",
      message: "本次 Session 已绑定其他 Client ID",
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("[连接拒绝]"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("状态=已拒绝"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("客户端IP=203.0.113.11"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Client ID=11111111"));
    expect(write.mock.calls.map(([value]) => String(value)).join("")).not.toContain("11111111-1111-4111-8111-111111111111");
    write.mockRestore();
  });

  it("prints English labels and fields for an English Session", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new OperationLogger(".", "logging-test", false, "en");

    logger.event({ action: "client.rejected", status: "denied", clientIp: "203.0.113.11" });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("[Connection rejected]"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Status=denied"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Client IP=203.0.113.11"));
    expect(write.mock.calls.map(([value]) => String(value)).join("")).not.toMatch(/[\u3400-\u9fff]/);
    write.mockRestore();
  });

  it("explains dynamic readonly rules in the Session language", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new OperationLogger(".", "logging-test", false, "en");
    logger.event({ action: "job.denied", status: "denied", rule: "readonly-command:python3", command: "python3 -V" });
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("command python3 is not registered in the readonly allowlist");
    expect(output).not.toMatch(/[\u3400-\u9fff]/);
    write.mockRestore();
  });
});
