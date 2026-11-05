"""Evidence-based chain identity, shared by live ranking, stored places and replay.

Only a provider brand, brand Wikidata ID, or the approved CHAINS list can identify a
chain. Equal independent business names never establish identity. Aliases bridge missing
metadata only when the observed provider evidence points to a single Wikidata identity.
"""

import re
from collections.abc import Iterable
from typing import Protocol

from app.categories import match_chain, normalize


class ChainPlace(Protocol):
    name: str
    brand: str | None
    brand_wikidata: str | None


def brand_text(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 200:
        return None
    # Multi-brand venues have no single chain identity.
    return value.strip() if ";" not in value else None


def wikidata_id(value: object) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"Q[1-9]\d*", value) else None


def retained_identity(current: ChainPlace, previous: ChainPlace) -> tuple[str | None, str | None]:
    """Retain omitted evidence for the exact same provider place, never a changed identity.

    Callers must match place IDs first. This is also the persistence trigger's policy.
    """
    brand, qid = brand_text(current.brand), wikidata_id(current.brand_wikidata)
    old_brand, old_qid = brand_text(previous.brand), wikidata_id(previous.brand_wikidata)
    if brand is None and (qid is None or qid == old_qid):
        brand = old_brand
    if qid is None and (brand is None or brand == old_brand):
        qid = old_qid
    return brand, qid


def chain_name(place: ChainPlace) -> str | None:
    brand = brand_text(place.brand)
    matched = match_chain(brand or place.name)
    return brand or (matched[0] if matched else None)


def aliases(place: ChainPlace) -> tuple[str, ...]:
    brand = brand_text(place.brand)
    matched = match_chain(brand or place.name)
    return tuple(dict.fromkeys(x for x in (
        normalize(brand) if brand else None, normalize(matched[0]) if matched else None,
    ) if x))


class ChainResolver:
    def __init__(self, places: Iterable[ChainPlace] = ()):
        self.wikidata_by_alias: dict[str, set[str]] = {}
        self._keys: dict[tuple[str, str | None, str | None], str | None] = {}
        seen = set()
        for place in places:
            signature = self._signature(place)
            if signature in seen:
                continue
            seen.add(signature)
            qid = wikidata_id(place.brand_wikidata)
            if qid:
                for alias in aliases(place):
                    self.wikidata_by_alias.setdefault(alias, set()).add(qid)

    @staticmethod
    def _signature(place: ChainPlace) -> tuple[str, str | None, str | None]:
        brand = brand_text(place.brand)
        return brand or place.name, brand, wikidata_id(place.brand_wikidata)

    def key(self, place: ChainPlace) -> str | None:
        signature = self._signature(place)
        if signature not in self._keys:
            self._keys[signature] = self._key(place)
        return self._keys[signature]

    def _key(self, place: ChainPlace) -> str | None:
        if qid := wikidata_id(place.brand_wikidata):
            return f"wikidata:{qid}"
        names = aliases(place)
        if not names:
            return None
        known = set().union(*(self.wikidata_by_alias.get(name, set()) for name in names))
        if len(known) == 1:
            return f"wikidata:{next(iter(known))}"
        # Provider brand wins over the name fallback. Conflicting QIDs never merge.
        return f"brand:{names[0]}"
