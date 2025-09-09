const fs = require("fs");
const path = require("path");

class LlmMessengerMod {
    constructor() {
        this.modName = "eft-llm-messenger";
        this.modPath = path.resolve(__dirname, "..");
        this.config = this.loadConfig();
        this.contextDir = path.join(this.modPath, "storage", "sessions");
        this.logsDir = path.join(this.modPath, "logs");
    }

    loadConfig() {
        try {
            const cfgPath = path.join(this.modPath, "config", "llm.json");
            return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        } catch (e) {
            console.error("[LLM] Failed to load config:", e);
            return {
                contactName: "Handler-AI",
                contactTraderId: "handler_ai",
                contactHex: "aaaaaaaaaaaaaaaaaaaaaaaa",
                model: { baseUrl: "http://localhost:11434", modelName: "qwen2.5:7b", apiKey: "" },
                prompt: { system: "You are a helpful Tarkov handler.", maxTurns: 6, maxTokens: 256, temperature: 0.3 },
                limits: { perDialogMaxContextKb: 64 },
                debug: false
            };
        }
    }

    preAkiLoad(container) {
        this.container = container;
        this.logger = container.resolve("WinstonLogger");
        this.profileHelper = container.resolve("ProfileHelper");
        this.dialogueController = container.resolve("DialogueController");
        this.dialogueCallbacks = container.resolve("DialogueCallbacks");
        this.hashUtil = container.resolve("HashUtil");
        this.timeUtil = container.resolve("TimeUtil");
        this.httpResponse = container.resolve("HttpResponse");

        const staticRouter = container.resolve("StaticRouterModService");
        staticRouter.registerStaticRouter(`${this.modName}-routes`, [
            { url: "/client/game/start", action: (url, info, sessionId, output) => this.routeGameStart(sessionId, output, "game/start") },
            { url: "/client/game/profile/select", action: (url, info, sessionId, output) => this.routeGameStart(sessionId, output, "profile/select") },
            { url: "/client/friend/list", action: (url, info, sessionId, output) => this.routeFriendList(sessionId, output) },
            { url: "/client/mail/dialog/list", action: (url, info, sessionId, output) => this.routeDialogList(sessionId, output) },
            { url: "/client/mail/dialog/send", action: (url, info, sessionId, output) => this.routeDialogSend(url, info, sessionId) },
            { url: "/eft-llm/health", action: () => this.httpResponse.getBody({ status: "ok" }) }
        ], "aki");
    }

    // ----- Route handlers -----
    routeGameStart(sessionId, output, tag) {
        this.logRoute(tag);
        try {
            this.seedDialogue(sessionId);
        } catch (e) {
            this.logger.error(`[LLM] seed failed: ${e?.message}`);
        }
        return output;
    }

    routeFriendList(sessionId, output) {
        this.logRoute("friend/list");
        const json = this.safeParse(output);
        if (!json) { return output; }
        const list = json?.data;
        if (Array.isArray(list)) {
            const exists = list.some(f => f._id === this.config.contactTraderId);
            if (!exists) {
                list.push({
                    _id: this.config.contactTraderId,
                    aid: 0,
                    Nickname: this.config.contactName,
                    Level: 1,
                    Side: "Bear",
                    bannedState: "",
                    banTime: 0,
                    online: false,
                    _location: "",
                    additionals: { accountType: 0 }
                });
            }
            this.debugSnapshot("friend_list", json);
            return JSON.stringify(json);
        }
        return output;
    }

    routeDialogList(sessionId, output) {
        this.logRoute("mail/dialog/list");
        const json = this.safeParse(output);
        if (!json) { return output; }
        const list = Array.isArray(json.data) ? json.data : Array.isArray(json.dialogues) ? json.dialogues : null;
        if (Array.isArray(list)) {
            const exists = list.some(d => d._id === this.config.contactHex);
            if (!exists) {
                const profile = this.profileHelper.getFullProfile(sessionId);
                const dialog = profile?.dialogues?.[this.config.contactHex];
                if (dialog) {
                    const summary = { ...dialog, messages: dialog.messages.slice(-1) };
                    list.push(summary);
                }
            }
            this.debugSnapshot("dialog_list", json);
            return JSON.stringify(json);
        }
        return output;
    }

    async routeDialogSend(url, info, sessionId) {
        this.logRoute("mail/dialog/send");
        const result = await this.dialogueCallbacks.sendMessage(url, info, sessionId);
        let data = typeof info === "string" ? this.safeParse(info) : info;
        data = data?.data || data;
        const dialogId = data?.dialogId || data?._id || "";
        const text = data?.text || "";
        if (dialogId === this.config.contactHex && text) {
            await this.handleUserMessage(sessionId, text);
        }
        return result;
    }

    // ----- Core logic -----
    seedDialogue(sessionId) {
        const profile = this.profileHelper.getFullProfile(sessionId);
        if (!profile?.dialogues) { return; }
        if (profile.dialogues[this.config.contactHex]) { return; }
        const ts = this.timeUtil.getTimestamp();
        profile.dialogues[this.config.contactHex] = {
            _id: this.config.contactHex,
            type: 1,
            Users: [this.config.contactTraderId, sessionId],
            messages: [
                {
                    _id: this.hashUtil.generate(),
                    type: "text",
                    text: `${this.config.contactName} ready.`,
                    dt: ts,
                    uid: this.config.contactTraderId
                }
            ],
            pinned: false,
            attachmentsNew: 0,
            new: 0,
            associatedEvent: ""
        };
        this.logger.info(`[LLM] Created AI dialogue in profile: ${this.config.contactTraderId}`);
    }

    async handleUserMessage(sessionId, userText) {
        this.logger.info(`[LLM] Received user->AI: ${userText}`);
        const ctx = this.loadContext(sessionId);
        ctx.messages.push({ role: "user", content: userText });
        this.trimContext(ctx);
        const aiText = await this.callLlm(ctx.messages);
        ctx.messages.push({ role: "assistant", content: aiText });
        this.saveContext(sessionId, ctx);

        const message = {
            _id: this.hashUtil.generate(),
            type: "text",
            text: aiText,
            dt: this.timeUtil.getTimestamp(),
            uid: this.config.contactTraderId
        };
        this.dialogueController.addMessageToDialogue(this.config.contactHex, message, sessionId, true);
        this.logger.info(`[LLM] Injected AI reply via DialogueController`);
    }

    async callLlm(messages) {
        try {
            const payload = {
                model: this.config.model.modelName,
                messages,
                temperature: this.config.prompt.temperature,
                max_tokens: this.config.prompt.maxTokens
            };
            const headers = { "Content-Type": "application/json" };
            if (this.config.model.apiKey) {
                headers["Authorization"] = `Bearer ${this.config.model.apiKey}`;
            }
            const res = await fetch(`${this.config.model.baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            return data?.choices?.[0]?.message?.content?.trim() || "";
        } catch (e) {
            this.logger.error(`[LLM] LLM request failed: ${e?.message}`);
            return "";
        }
    }

    // ----- Context utilities -----
    loadContext(sessionId) {
        const file = path.join(this.contextDir, `${sessionId}.json`);
        try {
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, "utf-8"));
            }
            fs.mkdirSync(this.contextDir, { recursive: true });
            let ctx = { messages: [] };
            const seed = path.join(this.modPath, "TEST-SESSION.json");
            if (fs.existsSync(seed)) {
                ctx = JSON.parse(fs.readFileSync(seed, "utf-8"));
            } else {
                ctx.messages.push({ role: "system", content: this.config.prompt.system });
            }
            fs.writeFileSync(file, JSON.stringify(ctx, null, 2));
            return ctx;
        } catch (e) {
            this.logger.error(`[LLM] loadContext failed: ${e?.message}`);
            return { messages: [{ role: "system", content: this.config.prompt.system }] };
        }
    }

    saveContext(sessionId, ctx) {
        try {
            fs.writeFileSync(path.join(this.contextDir, `${sessionId}.json`), JSON.stringify(ctx, null, 2));
        } catch (e) {
            this.logger.error(`[LLM] saveContext failed: ${e?.message}`);
        }
    }

    trimContext(ctx) {
        const kb = this.config.limits?.perDialogMaxContextKb || 64;
        const limit = kb * 1024;
        while (Buffer.byteLength(JSON.stringify(ctx)) > limit && ctx.messages.length > 1) {
            ctx.messages.splice(1, 2);
        }
        const maxTurns = this.config.prompt?.maxTurns;
        if (maxTurns && ctx.messages.length > 1 + maxTurns * 2) {
            ctx.messages.splice(1, ctx.messages.length - (1 + maxTurns * 2));
        }
    }

    // ----- Helpers -----
    safeParse(str) {
        try { return typeof str === "string" ? JSON.parse(str) : str; } catch { return null; }
    }

    logRoute(name) {
        this.logger.info(`[LLM] Route: ${name}`);
    }

    debugSnapshot(tag, data) {
        if (!this.config.debug) { return; }
        try {
            fs.mkdirSync(this.logsDir, { recursive: true });
            fs.writeFileSync(path.join(this.logsDir, `${tag}-${Date.now()}.json`), JSON.stringify(data, null, 2));
        } catch (e) {
            this.logger.error(`[LLM] debugSnapshot failed: ${e?.message}`);
        }
    }
}

module.exports = { mod: new LlmMessengerMod() };
