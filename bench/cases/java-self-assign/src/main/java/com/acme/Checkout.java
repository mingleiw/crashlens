package com.acme;

import java.math.BigDecimal;

public class Checkout {
    private final PriceFormatter formatter;

    public Checkout(PriceFormatter formatter) {
        this.formatter = formatter;
    }

    public String total(BigDecimal usd) {
        return "Total: " + formatter.format(usd);
    }
}
