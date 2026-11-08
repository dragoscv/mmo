//! Native strings (tray, mini-player title, sign-in callback page). EN + RO; RO when the OS locale is Romanian.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    Ro,
}

pub fn lang_from(tag: Option<&str>) -> Lang {
    match tag {
        Some(t) if t.to_ascii_lowercase().starts_with("ro") => Lang::Ro,
        _ => Lang::En,
    }
}

pub fn current() -> Lang {
    lang_from(sys_locale::get_locale().as_deref())
}

pub fn t(lang: Lang, key: &str) -> &'static str {
    let ro = lang == Lang::Ro;
    match key {
        "show" => if ro { "Deschide MixAI Music" } else { "Open MixAI Music" },
        "toggle" => if ro { "Redare / Pauză" } else { "Play / Pause" },
        "next" => if ro { "Următoarea piesă" } else { "Next track" },
        "previous" => if ro { "Piesa anterioară" } else { "Previous track" },
        "mini" => "Mini player",
        "quit" => if ro { "Ieșire" } else { "Quit" },
        "tooltip" => "MixAI Music",
        "signedIn" => if ro { "Te-ai autentificat" } else { "You're signed in" },
        "signedInBody" => if ro { "Întoarce-te în MixAI Music — poți închide această filă." } else { "Return to MixAI Music — you can close this tab." },
        "signInFailed" => if ro { "Autentificarea a eșuat" } else { "Sign-in failed" },
        "signInFailedBody" => if ro { "Cererea nu se potrivește cu una în curs. Încearcă din nou din aplicație." } else { "The request didn't match one in progress. Try again from the app." },
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_romanian_only_for_ro_locales() {
        assert_eq!(lang_from(Some("ro-RO")), Lang::Ro);
        assert_eq!(lang_from(Some("RO")), Lang::Ro);
        assert_eq!(lang_from(Some("en-US")), Lang::En);
        assert_eq!(lang_from(Some("rm-CH")), Lang::En);
        assert_eq!(lang_from(None), Lang::En);
    }

    #[test]
    fn every_key_has_both_languages() {
        for k in ["show", "toggle", "next", "previous", "mini", "quit", "tooltip", "signedIn", "signedInBody", "signInFailed", "signInFailedBody"] {
            assert!(!t(Lang::En, k).is_empty(), "en {k}");
            assert!(!t(Lang::Ro, k).is_empty(), "ro {k}");
        }
    }
}
