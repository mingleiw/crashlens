package com.acme;

public class App {
    public static void main(String[] args) {
        OrderStore store = new OrderStore();
        store.save(new Order(4417L, "Dana Lee", "12 Harbour St, Leith"));
        store.save(new Order(4418L, "Sam Ortiz", "7 Mill Lane, York"));

        ShippingService shipping = new ShippingService(store);
        System.out.println(shipping.relabel(new Ticket(91, 4417, "damaged label")));
    }
}
