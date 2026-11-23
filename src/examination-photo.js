"use strict";
function imageDimensions(bytes, type) {
  let width = 0, height = 0;
  if (type === "png") {
    if (bytes.length >= 24 && bytes.subarray(12, 16).toString() === "IHDR") { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  } else {
    let i = 2;
    while (i + 4 < bytes.length) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda || i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  }
  return { width, height };
}
function invalid(message, school) {
  const error = new Error(message); error.status = 400;
  error.code = school ? "INVALID_SCHOOL_ID_PHOTO" : "INVALID_PATIENT_PHOTO"; throw error;
}
function boundedImage(value, school = false) {
  if (value === undefined) return undefined;
  if (value === "" || value === null) return "";
  const label = school ? "school ID image" : "patient photo";
  const match = typeof value === "string" && value.length <= (school ? 580000 : 180000) && value.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  const bytes = match && Buffer.from(match[2], "base64");
  if (!match || bytes.length < 24 || bytes.toString("base64") !== match[2] ||
    (match[1] === "png" ? bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" : bytes.subarray(0, 3).toString("hex") !== "ffd8ff")) invalid("Choose a valid, smaller JPEG or PNG " + label + ".", school);
  const { width, height } = imageDimensions(bytes, match[1]);
  if (school ? width < 100 || height < 60 || width > 1800 || height > 1800 : !width || width !== height || width > 600) {
    invalid(school ? "Choose a clear school ID image between 100 × 60 and 1800 × 1800 pixels." : "Choose a square patient photo up to 600 pixels.", school);
  }
  return value;
}
const examinationPhoto = value => boundedImage(value);
const schoolIdPhoto = value => boundedImage(value, true);
module.exports = { examinationPhoto, schoolIdPhoto };
