/** Localised labels for effect ids, param ids and choice values (keys in src/i18n/*.json). */
import type { TFunction } from "i18next";
import { formatValue, voiceParam, type ParamSpec } from "../lib/params";

const has = (t: TFunction, key: string) => t(key, { defaultValue: "" }) !== "";

export function fxLabel(t: TFunction, id: string): string {
    return has(t, `fx.${id}`) ? t(`fx.${id}`) : id;
}

export function paramLabel(t: TFunction, id: string): string {
    const v = voiceParam(id);
    if (v) {
        const name = has(t, `param.${v.base}`) ? t(`param.${v.base}`) : v.base;
        return t("param.voice", { n: v.voice, name });
    }
    return has(t, `param.${id}`) ? t(`param.${id}`) : id.replace(/_/g, " ");
}

export function choiceLabel(t: TFunction, spec: ParamSpec, raw: string): string {
    if (spec.id === "scale" && has(t, `scale.${raw}`)) return t(`scale.${raw}`);
    if (has(t, `choice.${raw}`)) return t(`choice.${raw}`);
    return raw;
}

export function valueLabel(t: TFunction, spec: ParamSpec, v: number): string {
    if (spec.unit === "choice") return choiceLabel(t, spec, spec.choices[Math.round(v)] ?? String(v));
    if (spec.unit === "toggle") return t(v >= 0.5 ? "choice.on" : "choice.off");
    return formatValue(spec, v);
}
