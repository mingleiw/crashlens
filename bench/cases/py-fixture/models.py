from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Order:
    id: str
    address: Optional[dict]
    items: list = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload):
        return cls(
            id=payload.get("orderId"),
            address=payload.get("shipping_address"),
            items=payload.get("items", []),
        )
