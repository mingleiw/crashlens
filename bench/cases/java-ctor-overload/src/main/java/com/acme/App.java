package com.acme;

public class App {
    public static void main(String[] args) {
        User user = UserFactory.fromSignup("u-208", "Dana Lee");
        System.out.println(new Greeter().greet(user));
    }
}
