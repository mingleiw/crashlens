package com.acme;

public class Greeter {
    public String greet(User user) {
        // New accounts may not have finished onboarding; greet them with
        // their id until the profile exists.
        return "Hello, " + user.getProfile().displayName();
    }
}
