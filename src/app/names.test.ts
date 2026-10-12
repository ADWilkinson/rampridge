import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/net/http";

const net = vi.hoisted(() => ({ checkName: vi.fn(), renameSession: vi.fn() }));
vi.mock("@/net/session", () => net);

const { checkNameAvailability, claimName, nameRefusal } = await import("./names");

beforeEach(() => {
  net.checkName.mockReset();
  net.renameSession.mockReset();
});

describe("nameRefusal", () => {
  it("explains a taken or invalid name and leaves other errors alone", () => {
    expect(nameRefusal(new ApiError(409, "name_taken", "Name taken"))).toBe("That name is taken.");
    expect(nameRefusal(new ApiError(400, "bad_request", "Names can't contain that word."))).toBe("Names can't contain that word.");
    expect(nameRefusal(new ApiError(0, "network", "offline"))).toBeNull();
    expect(nameRefusal(new Error("boom"))).toBeNull();
  });
});

describe("checkNameAvailability", () => {
  it("only asks the session API and never renames", async () => {
    net.checkName.mockResolvedValue(undefined);
    expect(await checkNameAvailability("Zezima")).toEqual({ available: true });
    expect(net.checkName).toHaveBeenCalledWith("Zezima");
    expect(net.renameSession).not.toHaveBeenCalled();
  });

  it("reports a taken name as unavailable", async () => {
    net.checkName.mockRejectedValue(new ApiError(409, "name_taken", "Name taken"));
    expect(await checkNameAvailability("Zezima")).toEqual({ available: false, reason: "That name is taken." });
  });

  it("throws a network failure so the field can say the check failed", async () => {
    net.checkName.mockRejectedValue(new ApiError(0, "network", "Can't reach the RampRidge server."));
    await expect(checkNameAvailability("Zezima")).rejects.toThrow("Can't reach");
  });
});

describe("claimName", () => {
  it("renames the session", async () => {
    net.renameSession.mockResolvedValue({ name: "Zezima" });
    expect(await claimName("Zezima")).toBeUndefined();
    expect(net.renameSession).toHaveBeenCalledWith("Zezima");
  });

  it("returns the reason when the name went between the check and the claim", async () => {
    net.renameSession.mockRejectedValue(new ApiError(409, "name_taken", "Name taken"));
    expect(await claimName("Zezima")).toBe("That name is taken.");
  });

  it("throws other failures", async () => {
    net.renameSession.mockRejectedValue(new ApiError(503, "server", "The RampRidge server is having trouble."));
    await expect(claimName("Zezima")).rejects.toThrow("having trouble");
  });
});
