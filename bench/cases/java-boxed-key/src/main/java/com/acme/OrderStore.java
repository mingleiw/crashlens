package com.acme;

import java.util.HashMap;
import java.util.Map;

public class OrderStore {
    private final Map<Long, Order> orders = new HashMap<>();

    public void save(Order order) {
        orders.put(order.id(), order);
    }

    public Order byId(int id) {
        return orders.get(id);
    }
}
