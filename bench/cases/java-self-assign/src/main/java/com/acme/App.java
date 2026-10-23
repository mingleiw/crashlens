package com.acme;

import java.math.BigDecimal;

public class App {
    public static void main(String[] args) {
        Checkout checkout = new Checkout(new PriceFormatter("EUR", Rates.latest()));
        System.out.println(checkout.total(new BigDecimal("49.99")));
    }
}
