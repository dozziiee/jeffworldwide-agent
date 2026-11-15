import { describe, expect, it } from "vitest";
import { buildDemoVin, checkDigit, isValidVin, modelYearCode, wmiFor } from "./vin";

describe("VIN check digit", () => {
  it("matches known valid VINs", () => {
    expect(checkDigit("1M8GDM9AXKP042788")).toBe("X"); // the standard worked example
    expect(checkDigit("11111111111111111")).toBe("1");
    expect(isValidVin("1M8GDM9AXKP042788")).toBe(true);
    expect(isValidVin("5YJSA1E26HF000337")).toBe(false); // right shape, wrong check digit
  });

  it("rejects I, O and Q, and the wrong length", () => {
    expect(isValidVin("1M8GDM9AXKP04278")).toBe(false);
    expect(isValidVin("1M8GDM9AXKPO42788")).toBe(false);
    expect(() => checkDigit("IM8GDM9AXKP042788")).toThrow();
  });
});

describe("model year code", () => {
  it.each([
    [2012, "C"],
    [2014, "E"],
    [2016, "G"],
    [2017, "H"],
    [2018, "J"],
    [2019, "K"],
    [2020, "L"],
    [2021, "M"],
    [2022, "N"],
    [2023, "P"],
    [2024, "R"],
    [2009, "9"],
    [2001, "1"],
    [2000, "Y"],
  ])("%i -> %s", (year, code) => expect(modelYearCode(year)).toBe(code));
});

describe("WMI by make and model", () => {
  it.each([
    ["Mercedes-Benz", "GLE 450", "4JG"],
    ["Mercedes-Benz", "GLE 63 S AMG", "4JG"],
    ["Mercedes-Benz", "GLC 300", "W1N"],
    ["Mercedes-Benz", "G 63 AMG", "W1N"],
    ["Mercedes-Benz", "S-Class S 580", "W1K"],
    ["Mercedes-Benz", "E 350", "W1K"],
    ["Toyota", "Highlander", "5TD"],
    ["Toyota", "Camry", "4T1"],
    ["Toyota", "Corolla", "5YF"],
    ["Toyota", "FJ Cruiser", "JTE"],
    ["Lexus", "RX 350", "JTJ"],
    ["Lexus", "LX 600", "JTJ"],
    ["Lexus", "ES 350", "58A"],
    ["Cadillac", "Escalade", "1GY"],
    ["Porsche", "Cayenne Coupe", "WP1"],
    ["Honda", "Accord", "1HG"],
    ["Honda", "CR-V", "2HK"],
    ["Honda", "Pilot", "5FN"],
    ["Lamborghini", "Urus S", "ZPB"],
    ["Tesla", "Cybertruck", "7G2"],
  ])("%s %s -> %s", (make, model, wmi) => expect(wmiFor(make, model)).toBe(wmi));

  it("fails loudly for a make it does not know", () => {
    expect(() => wmiFor("Ferrari", "Roma")).toThrow();
  });
});

describe("buildDemoVin", () => {
  const vin = buildDemoVin({ wmi: "5TD", descriptor: "GZRBH", year: 2021, plant: "S", carNumber: 65 });

  it("is 17 characters with the WMI, year code and demo serial in place", () => {
    expect(vin).toHaveLength(17);
    expect(vin.slice(0, 3)).toBe("5TD");
    expect(vin[9]).toBe("M"); // 2021
    expect(vin.slice(11)).toBe("JW0065");
    expect(vin).not.toMatch(/[IOQ]/);
  });

  it("has a valid check digit in position 9", () => {
    expect(vin[8]).toBe(checkDigit(vin));
    expect(isValidVin(vin)).toBe(true);
  });

  it("is deterministic and unique per car number", () => {
    const again = buildDemoVin({ wmi: "5TD", descriptor: "GZRBH", year: 2021, plant: "S", carNumber: 65 });
    const other = buildDemoVin({ wmi: "5TD", descriptor: "GZRBH", year: 2021, plant: "S", carNumber: 66 });
    expect(again).toBe(vin);
    expect(other).not.toBe(vin);
    expect(isValidVin(other)).toBe(true);
  });
});
