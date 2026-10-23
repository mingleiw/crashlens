package com.acme;

import java.math.BigDecimal;
import java.util.Map;

public final class Rates {
    private Rates() {}

    public static Map<String, BigDecimal> latest() {
        return Map.of(
            "EUR", new BigDecimal("0.92"),
            "GBP", new BigDecimal("0.79"),
            "JPY", new BigDecimal("151.30"));
    }
}
