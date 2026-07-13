"use strict";

const fsp = require("fs").promises;
const fs = require("fs");
const path = require("path");

const ROLE_HIERARCHY = ["USER", "SUDO", "OWNER"];

function normalizeUserId(userId) {
    return String(userId || "").trim();
}

function normalizeRole(role) {
    const up = String(role || "USER").trim().toUpperCase();
    if (up === "ADMIN") return "SUDO";
    return ROLE_HIERARCHY.includes(up) ? up : "USER";
}

function toSet(values) {
    return new Set((Array.isArray(values) ? values : []).map((v) => normalizeUserId(v)).filter(Boolean));
}

function createTelegramRBAC({ ownerTelegramId, logger, dbPath }) {
    const ownerId = normalizeUserId(ownerTelegramId);
    const filePath = dbPath || path.join(__dirname, "../../data/telegram-roles.json");

    let store = {
        sudoUserIds: [],
    };

    async function load() {
        try {
            if (!fs.existsSync(path.dirname(filePath))) {
                await fsp.mkdir(path.dirname(filePath), { recursive: true });
            }
            const raw = await fsp.readFile(filePath, "utf8");
            const parsed = JSON.parse(raw || "{}");
            store = {
                sudoUserIds: Array.from(toSet([
                    ...(parsed.sudoUserIds || []),
                    ...(parsed.adminUserIds || []),
                ])),
            };
        } catch {
            store = { sudoUserIds: [] };
            await save();
        }
    }

    async function save() {
        if (!fs.existsSync(path.dirname(filePath))) {
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
        }
        await fsp.writeFile(filePath, JSON.stringify(store, null, 2), "utf8");
    }

    function getUserRole(userId) {
        const id = normalizeUserId(userId);
        if (!id) return "USER";
        if (id === ownerId) return "OWNER";

        const sudo = toSet(store.sudoUserIds);
        if (sudo.has(id)) return "SUDO";

        return "USER";
    }

    function getRoleLevel(role) {
        return ROLE_HIERARCHY.indexOf(normalizeRole(role));
    }

    function hasRolePermission(userRole, requiredRole = "USER") {
        const userLevel = getRoleLevel(userRole);
        const requiredLevel = getRoleLevel(requiredRole);
        return userLevel >= requiredLevel;
    }

    function hasPermission(userId, requiredRole = "USER") {
        const role = getUserRole(userId);
        return hasRolePermission(role, requiredRole);
    }

    function getAllRoleAssignments() {
        return {
            ownerUserId: ownerId,
            sudoUserIds: Array.from(toSet(store.sudoUserIds)),
            adminUserIds: [],
        };
    }

    function clearFromDynamicRoles(userId) {
        const id = normalizeUserId(userId);
        store.sudoUserIds = store.sudoUserIds.filter((x) => normalizeUserId(x) !== id);
    }

    async function setUserRole(actorUserId, targetUserId, role) {
        const actorId = normalizeUserId(actorUserId);
        const targetId = normalizeUserId(targetUserId);
        const nextRole = normalizeRole(role);

        if (!targetId) throw new Error("Target userId is required.");

        if (!hasRolePermission(getUserRole(actorId), "SUDO")) {
            throw new Error("Only OWNER or SUDO (Global Owner) can assign roles.");
        }

        if (nextRole === "OWNER") {
            throw new Error("OWNER role cannot be assigned dynamically.");
        }

        if (targetId === ownerId) {
            throw new Error("Cannot modify OWNER role.");
        }

        clearFromDynamicRoles(targetId);

        if (nextRole === "SUDO") {
            store.sudoUserIds.push(targetId);
        }

        store.sudoUserIds = Array.from(toSet(store.sudoUserIds));

        await save();

        logger.info("[RBAC] Role updated", {
            actorUserId: actorId,
            targetUserId: targetId,
            role: nextRole,
        });

        return getUserRole(targetId);
    }

    async function removeDynamicRole(actorUserId, targetUserId) {
        return setUserRole(actorUserId, targetUserId, "USER");
    }

    return {
        ROLE_HIERARCHY,
        load,
        save,
        getUserRole,
        hasPermission,
        hasRolePermission,
        getAllRoleAssignments,
        setUserRole,
        removeDynamicRole,
        normalizeRole,
    };
}

module.exports = { createTelegramRBAC, ROLE_HIERARCHY };
