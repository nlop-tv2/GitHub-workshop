import { describe, expect, it } from "vitest";
import { gameModule } from "./index";

describe("game module", () => {
  it("exposes the game module placeholder", () => {
    expect(gameModule).toBe("game");
  });
});
