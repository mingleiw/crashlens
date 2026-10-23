package com.acme;

public class ShippingService {
    private final OrderStore store;

    public ShippingService(OrderStore store) {
        this.store = store;
    }

    public String relabel(Ticket ticket) {
        Order order = store.byId(ticket.orderId());
        // Orders archived after 90 days are no longer in the store, so a
        // ticket can point at an order we cannot load.
        return "Ship to: " + order.address().toUpperCase();
    }
}
