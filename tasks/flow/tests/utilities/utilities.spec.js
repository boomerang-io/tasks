import { expect } from "chai";
import {
  checkParameters,
  checkForJson,
  isValidJson,
  unsetField,
} from "../../libs/utilities.js";

describe("utilities", () => {
  it("checkParameters counts the empty params", () => {
    expect(checkParameters({ a: "value", b: "", c: '""', d: undefined })).to.equal(3);
  });

  it("checkForJson parses a JSON string", () => {
    expect(checkForJson('{"a":1}')).to.deep.equal({ a: 1 });
  });

  it("isValidJson returns false for invalid JSON", () => {
    expect(isValidJson("{not json")).to.be.false;
  });

  it("unsetField removes the field at every depth", () => {
    const object = { id: 1, name: "top", child: { id: 2, name: "nested" } };
    unsetField(object, "id");
    expect(object).to.deep.equal({ name: "top", child: { name: "nested" } });
  });
});
