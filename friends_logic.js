// friends_logic.js - Friends management and group assignment module

export function createFriend(name, emailOrPhone = "") {
  return {
    id: "f_" + Date.now(),
    name: name.trim(),
    tag: emailOrPhone.trim() || `${name.toLowerCase().replace(/\s+/g, '')}@splitwise`,
    addedAt: new Date().toISOString()
  };
}

export function generateFriendInviteCode(userId) {
  // 6-character random alphanumeric friend invite code
  return "FR-" + Math.random().toString(36).substring(2, 7).toUpperCase();
}

export function addFriendToGroup(group, friendName) {
  if (!group.members.includes(friendName)) {
    group.members.push(friendName);
    return true;
  }
  return false;
}

export function getAvailableFriendsForGroup(allFriends, groupMembers) {
  return allFriends.filter(f => !groupMembers.includes(f.name));
}
