// HTTP access to the three TencentDB Memory Hub services this adapter talks to:
//   MemoryPanel     (TENCENTDB_PANEL_URL)     /api/v1/*        x-tdai-user-key, per-user ACLs
//   MemoryCore      (TENCENTDB_MEMORY_URL)    /v3/*            shared Bearer + trusted x-tdai-* headers
//   MemoryKnowledge (TENCENTDB_KNOWLEDGE_URL) /v3/tools/call   no user identity; gated through the Panel
const trimUrl = (url) => url?.replace(/\/+$/, "") || undefined;
export function loadConfig(env) {
    const required = {
        TENCENTDB_TEAM_ID: env.TENCENTDB_TEAM_ID,
        TENCENTDB_AGENT_ID: env.TENCENTDB_AGENT_ID,
        TENCENTDB_USER_ID: env.TENCENTDB_USER_ID,
    };
    for (const [name, value] of Object.entries(required)) {
        if (!value)
            throw new Error(`Missing required configuration: ${name}`);
    }
    const panelUrl = trimUrl(env.TENCENTDB_PANEL_URL);
    const baseUrl = trimUrl(env.TENCENTDB_MEMORY_URL || env.TENCENTDB_URL);
    const apiKey = env.TENCENTDB_API_KEY || undefined;
    const memoryAccess = (env.TENCENTDB_MEMORY_ACCESS || (panelUrl ? "panel" : "core"));
    if (memoryAccess !== "panel" && memoryAccess !== "core") {
        throw new Error("TENCENTDB_MEMORY_ACCESS must be 'panel' or 'core'.");
    }
    if (memoryAccess === "panel" && !panelUrl) {
        throw new Error("Missing required configuration: TENCENTDB_PANEL_URL");
    }
    if (memoryAccess === "core" && (!baseUrl || !apiKey)) {
        throw new Error("Missing required configuration: TENCENTDB_MEMORY_URL and TENCENTDB_API_KEY");
    }
    return {
        baseUrl,
        apiKey,
        serviceId: env.TENCENTDB_SERVICE_ID || "default",
        teamId: required.TENCENTDB_TEAM_ID,
        agentId: required.TENCENTDB_AGENT_ID,
        userId: required.TENCENTDB_USER_ID,
        panelUrl,
        // The caller check still rejects an admin key, whichever variable supplied it.
        userKey: env.TENCENTDB_USER_KEY || apiKey,
        knowledgeUrl: trimUrl(env.TENCENTDB_KNOWLEDGE_URL),
        memoryAccess,
    };
}
const ADMIN_REFUSAL = "the configured key belongs to a system_admin. Set this developer's own key; admin keys must not be used on developer workstations.";
export class Client {
    config;
    callerPromise;
    coreCheck;
    constructor(config) {
        this.config = config;
    }
    /** Removes configured secrets and bearer tokens from text leaving the adapter. */
    redact(text) {
        let out = text;
        for (const secret of [this.config.apiKey, this.config.userKey]) {
            if (secret)
                out = out.split(secret).join("[REDACTED]");
        }
        return out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    }
    /** True when text contains a credential this adapter holds. */
    containsConfiguredSecret(text) {
        return [this.config.apiKey, this.config.userKey].some((secret) => secret && text.includes(secret));
    }
    /** MemoryCore data plane. Identity is always this developer's env identity. */
    async core(endpoint, payload) {
        this.coreCheck ??= this.verifyCoreKey().catch((error) => {
            this.coreCheck = undefined;
            throw error;
        });
        await this.coreCheck;
        return this.coreRaw(endpoint, payload);
    }
    /** MemoryPanel, after confirming the key is this developer's and not an admin's. */
    async panel(path, payload) {
        await this.caller();
        return this.panelRaw(path, payload);
    }
    /**
     * MemoryKnowledge's read-only agent tools. The service has no user identity,
     * so callers must first confirm access to knowledgeId through the Panel.
     */
    async knowledgeTool(knowledgeId, toolName, params) {
        const { knowledgeUrl, serviceId } = this.config;
        if (!knowledgeUrl) {
            throw new Error("TENCENTDB_KNOWLEDGE_URL is not set. Code entity, relationship and file tools need it.");
        }
        await this.caller();
        return this.post("TencentDB Knowledge", `${knowledgeUrl}/v3/tools/call`, { knowledge_id: knowledgeId, tool_name: toolName, params }, { "x-tdai-service-id": serviceId });
    }
    /**
     * Resolves the key's real principal. Admin keys pass every Panel ACL, so
     * accepting one would silently replace developer permissions with admin ones.
     */
    caller() {
        this.callerPromise ??= this.verifyCaller().catch((error) => {
            this.callerPromise = undefined;
            throw error;
        });
        return this.callerPromise;
    }
    async verifyCaller() {
        const { panelUrl, userKey, userId } = this.config;
        if (!panelUrl) {
            throw new Error("TENCENTDB_PANEL_URL is not set. Team, wiki, code graph, skill and task tools need MemoryPanel; no agent-scoped substitute is used.");
        }
        if (!userKey) {
            throw new Error("TENCENTDB_USER_KEY is not set.");
        }
        const data = await this.panelRaw("/meta/auth/verify", { user_key: userKey });
        const user = data?.user;
        if (!data?.valid || !user) {
            throw new Error("TencentDB rejected the configured user key.");
        }
        if (user.user_type === "system_admin") {
            throw new Error(`Refusing to call MemoryPanel: ${ADMIN_REFUSAL}`);
        }
        if (user.user_id !== userId && user.username !== userId) {
            throw new Error(`Refusing to call MemoryPanel: the configured key belongs to '${user.username ?? user.user_id}', not TENCENTDB_USER_ID '${userId}'.`);
        }
        return user;
    }
    /** A shared gateway token is not a user key and verifies as invalid, which is fine. */
    async verifyCoreKey() {
        const data = await this.coreRaw("/v3/meta/auth/verify", { user_key: this.config.apiKey });
        if (data?.user?.user_type === "system_admin") {
            throw new Error(`Refusing to call MemoryCore: ${ADMIN_REFUSAL}`);
        }
    }
    coreRaw(endpoint, payload) {
        const { apiKey, serviceId, teamId, agentId, userId, baseUrl } = this.config;
        if (!baseUrl || !apiKey) {
            throw new Error("TENCENTDB_MEMORY_URL and TENCENTDB_API_KEY are required for MemoryCore access.");
        }
        return this.post("TencentDB", `${baseUrl}${endpoint}`, payload, {
            Authorization: `Bearer ${apiKey}`,
            "x-tdai-service-id": serviceId,
            "x-tdai-team-id": teamId,
            "x-tdai-agent-id": agentId,
            "x-tdai-user-id": userId,
        });
    }
    panelRaw(path, payload) {
        return this.post("TencentDB Panel", `${this.config.panelUrl}/api/v1${path}`, payload, {
            "x-tdai-service-id": this.config.serviceId,
            "x-tdai-user-key": this.config.userKey,
        });
    }
    async post(label, url, payload, headers) {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });
        const responseText = await response.text();
        let result;
        try {
            result = JSON.parse(responseText);
        }
        catch {
            throw new Error(`${label} returned non-JSON response (HTTP ${response.status}): ${responseText.slice(0, 500)}`);
        }
        // Code graph tool failures arrive as HTTP 500 with code 0 and data.isError.
        if (result?.data?.isError === true) {
            throw new Error(`${label} tool error (HTTP ${response.status}): ${result.data.text ?? "unknown"}`);
        }
        if (!response.ok || (typeof result.code === "number" && result.code !== 0)) {
            throw new Error(`${label} API error (HTTP ${response.status}): ${result.message || responseText.slice(0, 500)}`);
        }
        return result.data ?? result;
    }
}
