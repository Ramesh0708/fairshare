import { newId } from "./money.js";

export function normalizeEmail(email) {
  if (!email) return "";
  let clean = String(email).toLowerCase().trim();
  if (clean.endsWith("@gmail.com") || clean.endsWith("@googlemail.com")) {
    const [user, domain] = clean.split("@");
    const local = user.split("+")[0].replace(/\./g, "");
    clean = `${local}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
  }
  return clean;
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

/** Local or connected friend. Email is optional. */
export function createFriend(name, emailOrPhone = "") {
  const tag = String(emailOrPhone || "").trim();
  const email = tag.includes("@") ? tag.toLowerCase() : "";
  return {
    id: newId(),
    name: String(name || "").trim(),
    email,
    phone: email ? "" : tag,
    type: email ? "google" : "custom",
    approved: false,
    upiId: "",
    addedAt: new Date().toISOString()
  };
}

export function addFriendToGroup(group, friend) {
  if (!group.members) group.members = [];
  if (group.members.some((member) => member.id === friend.id)) return false;
  group.members.push({ id: friend.id, name: friend.name });
  return true;
}

export function getAvailableFriendsForGroup(allFriends, groupMembers) {
  const ids = new Set((groupMembers || []).map((member) => member.id));
  return (allFriends || []).filter((friend) => !ids.has(friend.id));
}
