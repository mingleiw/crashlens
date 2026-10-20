from dataclasses import dataclass
from typing import Optional


@dataclass
class Customer:
    id: str
    name: str
    email: str


@dataclass
class Order:
    id: str
    customer_ref: Optional[str]
    total: float
    currency: str = "USD"

    @classmethod
    def from_dict(cls, data):
        return cls(
            id=data.get("orderId"),
            customer_ref=data.get("customer_id"),
            total=float(data.get("total", 0)),
            currency=data.get("currency", "USD"),
        )
