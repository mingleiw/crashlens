package com.acme;

public class App {
    public static void main(String[] args) throws Exception {
        RegionResolver regions = new RegionResolver(Settings.load());
        System.out.println(regions.endpoint());
    }
}
