import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { CreatePurchaseToken, GetBalancesForUser, GetStoreCatalog, PurchaseCurrency, PurchaseFromToken } from "../controllers/store";
import { LogFullAttempt } from "../requestLogger";

export const storeRouter = Router();

export function WireBalances(Balances: Awaited<ReturnType<typeof GetBalancesForUser>>){
    return {
        CURRENCY_CELLDUST: 0,
        CURRENCY_EVENT_01: 0,
        CURRENCY_PLATINUM: 0,
        CURRENCY_PRESTIGE: 0,
        CURRENCY_PJM_PRESTIGE_EMPTY: 0,
        CURRENCY_PJM_PRESTIGE_FILLED: 0,
        id_currency_celldust: 0,
        id_currency_event_01: 0,
        id_currency_platinum: 0,
        id_currency_prestige: 0,
        id_currency_pjm_prestige_empty: 0,
        id_currency_pjm_prestige_filled: 0,
        ...Balances,
        id_currency_notes: Balances.CURRENCY_NOTES,
        id_currency_marks_steel: Balances.CURRENCY_MARKS_STEEL,
        id_currency_marks_gilded: Balances.CURRENCY_MARKS_GILDED,
    };
}

storeRouter.post("/reconcile", HasUndauntedMetagameAuth, async (req: any, res) => {
    res.status(200).json({balances: WireBalances(await GetBalancesForUser(req.AuthData.userId)), refreshInventory: true});
});

storeRouter.get("/creator", HasUndauntedMetagameAuth, (_req, res) => {
    res.status(200).json({expirationDate: "2099-01-01T01:00:00.041Z", slug: "MROWMROW", success: true});
});

storeRouter.get("/balance", HasUndauntedMetagameAuth, async (req: any, res) => {
    res.status(200).json(WireBalances(await GetBalancesForUser(req.AuthData.userId)));
});

storeRouter.get("/product/skus/public", HasUndauntedMetagameAuth, async (req: any, res) => {
    if(typeof req.query.requiredTags !== "string") return res.status(400).json({code: "400", message: "missing requiredTags query parameter"});
    const Tags = req.query.requiredTags.split(",").map((Tag: string) => Tag.trim()).filter(Boolean);
    const Catalog = await GetStoreCatalog(req.AuthData.userId, Tags);
    if(!Catalog) return res.status(400).json({code: "400", message: "unsupported store tags"});
    res.status(200).json(Catalog);
});

storeRouter.get("/token/platinum/:catalogId", HasUndauntedMetagameAuth, (req: any, res) => {
    const Token = CreatePurchaseToken(req.AuthData.userId, req.params.catalogId, "platinum");
    if(!Token){
        LogFullAttempt(req, "Unsupported store SKU full request");
        return res.status(404).json({code: "404", message: "unknown store product"});
    }
    res.status(200).json({purchaseToken: Token});
});

for(const Currency of ["markssteel", "marksgilded"] as PurchaseCurrency[]){
    storeRouter.get(`/token/${Currency}/:catalogId`, HasUndauntedMetagameAuth, (req: any, res) => {
        const Token = CreatePurchaseToken(req.AuthData.userId, req.params.catalogId, Currency);
        if(!Token){
            LogFullAttempt(req, "Unsupported store SKU full request");
            return res.status(404).json({code: "404", message: "unknown store product or currency mismatch"});
        }
        res.status(200).json({purchaseToken: Token});
    });
}

async function CompletePurchase(req: any, res: any, Currency?: PurchaseCurrency){
    if(typeof req.query.token !== "string") return res.status(400).json({code: "400", message: "missing token query parameter"});
    const Result = await PurchaseFromToken(req.AuthData.userId, req.query.token, Currency);
    if(Result.success){
        logger.info(`Completed Lady Luck purchase for ${req.AuthData.userId}`);
        return res.status(204).send();
    }
    const Status = Result.error === "insufficient_funds" ? 402 : Result.error === "already_owned" ? 409 : Result.error === "db_error" ? 500 : 400;
    res.status(Status).json({code: String(Status), message: Result.error});
}

storeRouter.post("/notification/platinum", HasUndauntedMetagameAuth, async (req: any, res) => {
    return CompletePurchase(req, res, "platinum");
});

for(const Currency of ["markssteel", "marksgilded"] as PurchaseCurrency[])
    storeRouter.post(`/notification/${Currency}`, HasUndauntedMetagameAuth, async (req: any, res) => CompletePurchase(req, res, Currency));
