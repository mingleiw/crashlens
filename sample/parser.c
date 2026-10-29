#include <stdio.h>
#include <string.h>
struct record { char name[16]; int *values; int count; };
static int sum(const struct record *r) {
  int total = 0;
  for (int i = 0; i < r->count; i++) total += r->values[i];   /* bug: values may be NULL */
  return total;
}
int main(int argc, char **argv) {
  struct record r; memset(&r, 0, sizeof r);
  strncpy(r.name, argc > 1 ? argv[1] : "empty", sizeof r.name - 1);
  r.count = 3;               /* count set, but values never allocated */
  printf("%s: %d\n", r.name, sum(&r));
  return 0;
}
