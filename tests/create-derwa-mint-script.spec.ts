import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";

describe("create-derwa-mint script", () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, "../scripts/create-derwa-mint.ts"),
    "utf-8",
  );

  it("fully wires MintConfig and ExtraAccountMetaList after mint creation", () => {
    expect(script).to.include("initializeMintConfig");
    expect(script).to.include("initializeExtraAccountMetaList");
    expect(script).to.include("fully_wired: true");
    expect(script).not.to.include("fully_wired: false");
    expect(script).not.to.include("compliance-hook lacks public initialize_mint_config");
  });
});
